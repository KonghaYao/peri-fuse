#!/usr/bin/env node
/**
 * Peri-Fuse CLI entry point.
 *
 * Manages the background observability server as a detached daemon.
 * Commands: start / stop / restart / status / logs.
 */
import { Command } from "commander";
import { logsCommand } from "./commands/logs";
import { restartCommand } from "./commands/restart";
import { startCommand } from "./commands/start";
import { statusCommand } from "./commands/status";
import { stopCommand } from "./commands/stop";

const program = new Command();

program
  .name("peri-fuse")
  .description("Manage the Peri-Fuse background observability server")
  .version("0.1.0");

program
  .command("start")
  .description("Start the server as a background daemon")
  .action(startCommand);

program
  .command("stop")
  .description("Stop the background server")
  .action(stopCommand);

program
  .command("restart")
  .description("Restart the background server")
  .action(restartCommand);

program
  .command("status")
  .description("Show whether the server is running")
  .action(statusCommand);

program
  .command("logs")
  .description("View server logs")
  .option("-n, --lines <number>", "Number of lines to show", "50")
  .option("-f, --follow", "Follow log output")
  .action(logsCommand);

// No subcommand given: print help and exit cleanly (code 0) instead of erroring.
program.action(() => {
  program.outputHelp();
});

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});
