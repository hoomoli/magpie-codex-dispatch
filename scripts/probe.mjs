import { createDispatcher } from '../src/dispatch.js';

const threadId = process.argv[2];
if (!threadId) {
  console.error('Usage: npm run probe -- <existing-thread-uuid>');
  process.exitCode = 2;
} else {
  try {
    const result = await createDispatcher({ socketPath: process.env.MAGPIE_CODEX_SOCKET })('status', { threadId });
    // A diagnostic must not print conversation text.
    const { output, ...metadata } = result;
    console.log(JSON.stringify({ ...metadata, outputCharacters: output.length }, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ code: error.code ?? 'ERROR', message: error.message }));
    process.exitCode = 1;
  }
}
