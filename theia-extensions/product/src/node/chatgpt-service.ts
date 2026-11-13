import { governedDataDirectory } from './data-directory';
import { injectable } from '@theia/core/shared/inversify';
import { createServer, Server, ServerResponse } from 'http';
import { createHash, randomBytes, randomUUID, createPublicKey, verify, timingSafeEqual } from 'crypto';
import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { join } from 'path';
import { ChatGptStatus } from '../common/project-service';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
interface Credentials {
    clientId: string; subject: string; email?: string; hostId: string;
    accessToken: string; refreshToken: string; idToken: string; expiresAt: number; scopes: string[];
}
interface Attempt {
    state: string; nonce: string; verifier: string; redirectUri: string; hostId: string;
    clientId?: string; subject?: string; used: boolean; server: Server; timer: ReturnType<typeof setTimeout>;
}

@injectable()
export class ChatGptService {
    protected directory = governedDataDirectory('auth', 'openai');
    protected attempt?: Attempt;
    protected lastError?: string;
    protected refreshing?: Promise<Credentials>;
    protected refreshError?: string;
    protected retryRefreshAt = 0;

    protected async readCredentials(): Promise<Credentials | undefined> {
        try { return JSON.parse(await readFile(join(this.directory, 'credentials.json'), 'utf8')); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Cannot read the saved ChatGPT connection.'); }
    }
    protected async atomicWrite(file: string, data: unknown): Promise<void> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const destination = join(this.directory, file); const temporary = `${destination}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
        await rename(temporary, destination);
    }
    protected async hostId(): Promise<string> {
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const file = join(this.directory, 'host.json');
        try { const stored = JSON.parse(await readFile(file, 'utf8')); if (typeof stored.id === 'string') return stored.id; throw new Error('Invalid host ID.'); }
        catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const id = `urn:uuid:${randomUUID()}`;
            try { await writeFile(file, JSON.stringify({ id }), { mode: 0o600, flag: 'wx' }); return id; }
            catch (writeError) { if ((writeError as NodeJS.ErrnoException).code === 'EEXIST') return JSON.parse(await readFile(file, 'utf8')).id; throw writeError; }
        }
    }
    async status(): Promise<ChatGptStatus> {
        const credentials = await this.readCredentials();
        let planEnabled = !!credentials?.scopes.includes('chatgpt.tokens.use.direct');
        if (planEnabled && credentials && credentials.expiresAt < Date.now() + 60000 && !this.attempt) {
            if (Date.now() >= this.retryRefreshAt) {
                try { await this.accessToken(); this.refreshError = undefined; this.retryRefreshAt = 0; }
                catch { this.refreshError = 'Could not renew your ChatGPT connection. Check your connection or sign in again.'; this.retryRefreshAt = Date.now() + 30000; }
            }
            if (this.refreshError) planEnabled = false;
        }
        return { signedIn: !!credentials, planEnabled, pending: !!this.attempt, email: credentials?.email, error: this.lastError || this.refreshError };
    }
    async cancel(): Promise<void> {
        const pending = this.attempt; this.attempt = undefined;
        if (pending) { clearTimeout(pending.timer); pending.server.close(); }
    }
    onStop(): void { void this.cancel(); }

    async startLogin(): Promise<{ authUrl: string }> {
        await this.cancel(); this.lastError = undefined;
        const saved = await this.readCredentials(); const hostId = await this.hostId();
        const state = randomBytes(32).toString('base64url'); const nonce = randomBytes(32).toString('base64url'); const verifier = randomBytes(48).toString('base64url');
        const server = createServer((request, response) => { void this.callback(request.url || '/', request.method || '', request.headers.host || '', response); });
        await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); }); });
        server.on('error', () => { this.lastError = 'The sign-in callback stopped. Please try again.'; void this.cancel(); });
        const address = server.address(); if (!address || typeof address === 'string') throw new Error('Cannot start the sign-in callback.');
        const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
        const timer = setTimeout(() => { this.lastError = 'Sign-in timed out. Please try again.'; void this.cancel(); }, 10 * 60 * 1000); timer.unref();
        this.attempt = { state, nonce, verifier, redirectUri, hostId, clientId: saved?.clientId, subject: saved?.subject, used: false, server, timer };
        const url = new URL(`${issuer}/api/accounts/authorize`);
        const parameters: Record<string, string> = { client_id: saved?.clientId || 'dynamic_agent_client', ext_agent_host_id: hostId, response_type: 'code', redirect_uri: redirectUri, scope: scopes, resource, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') };
        if (!saved) parameters.agent_name_hint = 'Governed IDE';
        else parameters.id_token_hint = saved.idToken;
        Object.entries(parameters).forEach(([key, value]) => url.searchParams.set(key, value));
        return { authUrl: url.toString() };
    }

    protected reply(response: ServerResponse, status: number, text: string): void {
        response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' }); response.end(text);
    }
    protected async callback(rawUrl: string, method: string, host: string, response: ServerResponse): Promise<void> {
        const attempt = this.attempt;
        if (!attempt || method !== 'GET' || host !== new URL(attempt.redirectUri).host) { this.reply(response, 400, 'Invalid sign-in request.'); return; }
        const url = new URL(rawUrl, attempt.redirectUri);
        if (url.pathname !== '/auth/callback') { this.reply(response, 404, 'Not found.'); return; }
        const state = url.searchParams.get('state') || '';
        if (attempt.used || Buffer.byteLength(state) !== Buffer.byteLength(attempt.state) || !timingSafeEqual(Buffer.from(state), Buffer.from(attempt.state))) { this.reply(response, 400, 'Invalid or expired sign-in state.'); return; }
        attempt.used = true;
        try {
            if (url.searchParams.has('error')) throw new Error('Sign-in or ChatGPT plan permission was declined. Please try again.');
            const code = url.searchParams.get('code'); const returnedClientId = url.searchParams.get('client_id');
            const clientId = attempt.clientId || returnedClientId;
            if (!code || !clientId || clientId === 'dynamic_agent_client' || (attempt.clientId && returnedClientId && returnedClientId !== attempt.clientId)) throw new Error('OpenAI did not return a valid application registration. Please try again.');
            const token = await this.tokenRequest(new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.redirectUri, resource }));
            const identity = await this.validateIdentity(token.id_token, clientId, attempt.nonce);
            if (attempt.subject && identity.subject !== attempt.subject) throw new Error('The signed-in account does not match this saved connection.');
            if (this.attempt !== attempt) throw new Error('This sign-in attempt was cancelled.');
            const credentials = this.credentialsFromToken(token, { clientId, subject: identity.subject, email: identity.email, hostId: attempt.hostId });
            await this.atomicWrite('credentials.json', credentials);
            this.refreshError = undefined; this.retryRefreshAt = 0;
            if (!credentials.scopes.includes('chatgpt.tokens.use.direct')) { this.lastError = 'Signed in, but ChatGPT plan access was not granted. Continue with ChatGPT again to authorize plan usage.'; this.reply(response, 200, 'Signed in. ChatGPT plan access was not granted. Return to Governed IDE to enable it.'); }
            else { this.lastError = undefined; this.reply(response, 200, 'Connected to Governed IDE. You can close this tab and return to the app.'); }
        } catch (error) {
            this.lastError = error instanceof Error ? error.message : 'Sign-in failed. Please try again.';
            this.reply(response, 400, this.lastError);
        } finally { if (this.attempt === attempt) await this.cancel(); }
    }

    protected async tokenRequest(body: URLSearchParams): Promise<Record<string, unknown>> {
        const response = await fetch(`${issuer}/api/accounts/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(30000), redirect: 'error' });
        if (!response.ok) throw new Error('OpenAI could not complete authorization. Start sign-in again.');
        return await response.json() as Record<string, unknown>;
    }
    protected credentialsFromToken(token: Record<string, unknown>, base: Pick<Credentials, 'clientId' | 'subject' | 'email' | 'hostId'>, previous?: Credentials): Credentials {
        if (typeof token.access_token !== 'string' || String(token.token_type).toLowerCase() !== 'bearer' || typeof token.expires_in !== 'number' || token.expires_in <= 0) throw new Error('OpenAI returned an invalid token response.');
        const refreshToken = typeof token.refresh_token === 'string' ? token.refresh_token : previous?.refreshToken;
        const idToken = typeof token.id_token === 'string' ? token.id_token : previous?.idToken;
        if (!refreshToken || !idToken) throw new Error('OpenAI did not return a renewable session.');
        return { ...base, accessToken: token.access_token, refreshToken, idToken, expiresAt: Date.now() + token.expires_in * 1000, scopes: typeof token.scope === 'string' ? token.scope.split(/\s+/) : previous?.scopes || [] };
    }
    protected async validateIdentity(raw: unknown, clientId: string, nonce?: string): Promise<{ subject: string; email?: string }> {
        if (typeof raw !== 'string') throw new Error('OpenAI did not return an identity token.');
        const pieces = raw.split('.'); if (pieces.length !== 3) throw new Error('Invalid identity token.');
        const header = JSON.parse(Buffer.from(pieces[0], 'base64url').toString());
        if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Unsupported identity token signature.');
        const response = await fetch(`${issuer}/.well-known/jwks.json`, { signal: AbortSignal.timeout(10000), redirect: 'error' });
        if (!response.ok) throw new Error('Could not validate the OpenAI identity.');
        const jwks = await response.json() as { keys: { kid?: string; use?: string; alg?: string; kty: string; n: string; e: string }[] };
        const jwk = jwks.keys.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
        if (!jwk || !verify('RSA-SHA256', Buffer.from(`${pieces[0]}.${pieces[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(pieces[2], 'base64url'))) throw new Error('Invalid OpenAI identity signature.');
        const claims = JSON.parse(Buffer.from(pieces[1], 'base64url').toString()); const now = Math.floor(Date.now() / 1000);
        if (claims.iss !== issuer || !(Array.isArray(claims.aud) ? claims.aud.includes(clientId) : claims.aud === clientId) || typeof claims.exp !== 'number' || claims.exp <= now || (typeof claims.nbf === 'number' && claims.nbf > now + 30) || (nonce && claims.nonce !== nonce) || typeof claims.sub !== 'string' || !claims.sub) throw new Error('OpenAI identity validation failed.');
        return { subject: claims.sub, email: typeof claims.email === 'string' ? claims.email : undefined };
    }

    async accessToken(): Promise<string> {
        let credentials = await this.readCredentials();
        if (!credentials?.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('Sign in with ChatGPT and enable plan usage first.');
        if (credentials.expiresAt < Date.now() + 60000) {
            if (!this.refreshing) this.refreshing = this.refreshCredentials(credentials).finally(() => { this.refreshing = undefined; });
            credentials = await this.refreshing;
        }
        if (!credentials.scopes.includes('chatgpt.tokens.use.direct')) throw new Error('ChatGPT plan access is no longer granted. Sign in again.');
        return credentials.accessToken;
    }
    protected async refreshCredentials(previous: Credentials): Promise<Credentials> {
        const token = await this.tokenRequest(new URLSearchParams({ grant_type: 'refresh_token', client_id: previous.clientId, refresh_token: previous.refreshToken, resource }));
        if (token.id_token) { const identity = await this.validateIdentity(token.id_token, previous.clientId); if (identity.subject !== previous.subject) throw new Error('OpenAI refreshed a different account. Sign in again.'); }
        const credentials = this.credentialsFromToken(token, previous, previous); await this.atomicWrite('credentials.json', credentials); return credentials;
    }
    async streamResponse(input: unknown[], instructions: string, tools: unknown[] = [], abort?: AbortSignal, toolChoice: 'auto' | 'required' = 'auto'): Promise<Response> {
        const signal = abort ? AbortSignal.any([abort, AbortSignal.timeout(10 * 60 * 1000)]) : AbortSignal.timeout(10 * 60 * 1000);
        signal.throwIfAborted();
        const accessToken = await this.accessToken();
        const catalog = await fetch(`${resource}/models`, { headers: { Authorization: `Bearer ${accessToken}` }, signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]), redirect: 'error' });
        if (!catalog.ok) throw new Error('Cannot load the models available to this ChatGPT account.');
        const available = await catalog.json() as { models?: { slug: string; visibility: string }[] };
        const model = available.models?.find(item => item.visibility === 'list')?.slug;
        if (!model) throw new Error('No model is currently available for this ChatGPT connection.');
        const response = await fetch(`${resource}/responses`, { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, instructions, input, store: false, stream: true, include: ['reasoning.encrypted_content'], ...(tools.length ? { tools, tool_choice: toolChoice, parallel_tool_calls: false } : {}) }), signal, redirect: 'error' });
        if (!response.ok) throw new Error(`OpenAI request failed (${response.status}). Check ChatGPT plan usage or sign in again.`);
        return response;
    }
}
