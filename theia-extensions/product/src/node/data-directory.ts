import { homedir } from 'os';
import { isAbsolute, join } from 'path';

/** Shared application data, independent of the installation and project folder. */
export function governedDataDirectory(...parts: string[]): string {
    const override = process.env.GOVERNED_IDE_DATA_DIR;
    if (override !== undefined && (!isAbsolute(override) || /[\0\r\n]/.test(override))) throw new Error('GOVERNED_IDE_DATA_DIR must be an absolute directory.');
    return join(override || join(homedir(), '.governed-ide'), ...parts);
}
