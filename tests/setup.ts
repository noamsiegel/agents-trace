// Tests build throwaway git repos. The developer's global git config can install hooks
// (core.hooksPath) that add seconds per commit and push fixture setup past bun's 5s timeout,
// so every test, and every child process it spawns, runs against git defaults only.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
