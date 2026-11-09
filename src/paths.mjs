import { fileURLToPath } from "node:url";

/** The package's single entry point; the lease and authority commands run as `<bin> auto ...`. */
export const BIN = fileURLToPath(new URL("../bin/orca-orchestrator.mjs", import.meta.url));

/** Argv prefix for the lease/authority CLI, used wherever the Orca tools shell out to it. */
export const AUTO_COMMAND = Object.freeze(["node", BIN, "auto"]);
