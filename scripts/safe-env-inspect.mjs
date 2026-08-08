#!/usr/bin/env node
/**
 * Prints only environment-variable names for the env-guard's safe inspection
 * path. It never reads or transforms a variable value.
 */

const names = Object.keys(process.env).sort();

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(names, null, 2));
} else {
  for (const name of names) console.log(name);
}
