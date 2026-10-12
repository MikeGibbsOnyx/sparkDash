// Onyx: identity module shared by the Observer and the Gateway.
export { resolveIdentity, decodeHeaderWord } from "./resolve.js";
export { createWhois, parseWhois, DEFAULT_SOCKET } from "./whois.js";
export { isLoopbackIp, isTailnetIp, forwardedFor, normalizeIp } from "./net.js";
