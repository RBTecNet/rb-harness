/**
 * RB Harness executable entry point. The command surface itself lives in
 * `cli-program.ts` so it can be introspected without side effects.
 */
import { fail, runHarnessCli } from "./cli-program.js";

void runHarnessCli().catch(fail);
