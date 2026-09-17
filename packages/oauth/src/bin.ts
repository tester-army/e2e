#!/usr/bin/env node
import { runOAuthCli } from './cli.ts';

process.exitCode = await runOAuthCli(process.argv.slice(2));
