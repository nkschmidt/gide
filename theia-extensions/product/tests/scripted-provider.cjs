// Scripted model fixtures explicitly translate their declared messages/tool calls into the provider contract.
exports.scriptedProvider = provider => ({ ...provider, respond: async (...args) => {
    const reply = await provider.respond(...args);
    return { ...reply, outcome: reply.outcome || (reply.calls.length ? 'actions' : 'message') };
} });
