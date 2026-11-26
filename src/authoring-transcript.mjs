// Rows are already scoped by the host, newest first. Do not project raw
// provider history, tool arguments, scenario bytes or control receipts.
export function authoringTranscript(rows) {
  const messages = [];
  let bytes = 2;
  for (const row of rows) {
    const { role, text } = JSON.parse(row.payload);
    if (!['user', 'assistant', 'host'].includes(role) || typeof text !== 'string') continue;
    const message = { role, text };
    bytes += Buffer.byteLength(JSON.stringify(message)) + 1;
    if (bytes > 16384) return { messages: messages.reverse(), truncated: true };
    messages.push(message);
  }
  return { messages: messages.reverse(), truncated: false };
}
