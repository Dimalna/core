import { Command } from "commander";

export class CLI extends Command {
  constructor(
    public runtime = process.env.KYVE_RUNTIME!,
    public packageVersion = process.env.KYVE_VERSION!
  ) {
    super(runtime);

    this.option(
      "--name <string>",
      "The identifier name of the node. [optional, default = auto generated]"
    );
    this.requiredOption(
      "-p, --poolId <number>",
      "The id of the pool you want to run on."
    );
    this.requiredOption(
      "-m, --mnemonic <string>",
      "Your mnemonic of your account."
    );
    this.requiredOption(
      "-k, --keyfile <string>",
      "The path to your Arweave keyfile."
    );
    this.option(
      "-s, --initialStake <number>",
      "Your initial stake the node should start with. Flag is ignored node is already staked [unit = $KYVE]."
    );
    this.option(
      "-n, --network <string>",
      "The chain id of the network. [optional, default = korellia]",
      "korellia"
    );
    this.option(
      "-sp, --space <number>",
      "The size of disk space in bytes the node is allowed to use. [optional, default = 1000000000 (1 GB)]",
      "1000000000"
    );
    this.option(
      "-b, --batchSize <number>",
      "The batch size of fetching items from datasource. For synchronous fetching enter 1. [optional, default = 1]",
      "1"
    );
    this.option(
      "--metrics",
      "Run Prometheus metrics server. [optional, default = false]",
      false
    );
    this.option(
      "-v, --verbose",
      "Run node in verbose mode. [optional, default = false]",
      false
    );
    this.version(packageVersion, "--version");
  }
}
