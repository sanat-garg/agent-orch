// A parent process that starts a hanging helper (tree-stub) and then waits to be killed.
import { runHelper } from '../../helpers.mjs';
runHelper(process.argv[2], process.argv.slice(3), { timeoutMs: 120_000 });
setInterval(() => {}, 1000);
