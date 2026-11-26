# Photos bridge security

The extension uses Chrome's extension messaging to keep Photos commands, media keys and results inside the extension. GPTK's pinned API and parser run in the isolated content script. Their build excludes the toolkit UI and global initialization.

1. The service worker accepts requests from its own top-level app document. On connection it verifies a Photos tab and checks that the isolated bridge responds in that exact document.
2. A one-shot MAIN-world read returns a fixed set of bounded session fields through Chrome. It installs no page message listener and publishes no global. The worker checks the document and account before each command.
3. The worker sends a validated command and request-local session to the isolated document. The isolated bridge validates both, builds a fresh API instance, and returns results via extension messaging.
4. The worker accepts a response only while its random 128-bit request ID is pending, and only from the expected command, tab and document. An acknowledgement is required before the isolated bridge continues to another batch. Sessions and tokens never appear in the app's messages or persistent storage.

Each media result message is capped at 8 MiB and 10,000 items. Mutation inputs accept at most 10,000 unique keys with no key longer than 1,024 characters. GPTK still sends 250 keys per mutation request.

Page session fields are untrusted. A compromised page can alter its own session data or act within its existing Google Photos session. The boundary prevents it from invoking extension commands or reading extension messages through page events. It cannot revoke an RPC that Google already received. A lost acknowledgement stops later batches, so inspect Photos before retrying a mutation with an uncertain outcome.
