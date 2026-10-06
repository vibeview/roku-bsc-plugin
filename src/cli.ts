#!/usr/bin/env node
import { runInit } from './init';

const USAGE = `Usage: vibeview-bsc-plugin init [--force]

Adds the plugin to ./bsconfig.json and writes a "vibeview" block (markers off, Roku's
native list-item fields spelled out). Creates the file if it is missing. Refuses to
replace an existing "vibeview" block unless --force.`;

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command !== 'init' || rest.some((a) => a !== '--force')) {
    (command === '--help' || command === '-h' ? console.log : console.error)(USAGE);
    return command === '--help' || command === '-h' ? 0 : 1;
  }
  const result = runInit(process.cwd(), { force: rest.includes('--force') });
  for (const line of result.messages) (result.ok ? console.log : console.error)(line);
  return result.ok ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
