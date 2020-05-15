import {
  fetchAllRows,
  fetchHeadBlockNumbers,
  sendTransaction,
} from "./eos/fetch";
import { getContractsForNetwork } from "./eos/networks";
import { logger } from "./logger";
import {
  isNetworkName,
  NetworkName,
  TReportsRow,
  TReportsRowTransformed,
  TTransfersRow,
  TTransfersRowTransformed,
} from "./types";
import {
  extractRpcError,
  formatBloksTransaction,
  pickRandom,
  sleep,
} from "./utils";

export default class Reporter {
  network: NetworkName;
  transfers: TTransfersRowTransformed[] = [];
  transferIrreversibilityMap: { [key: string]: number } = {};
  reports: TReportsRowTransformed[] = [];
  currentHeadBlock = Infinity;
  currentIrreversibleHeadBlock = Infinity;

  constructor(networkName: NetworkName) {
    this.network = networkName;
  }

  log(level: string, ...args) {
    const [firstArg, ...otherArgs] = args;
    logger.log(level, `Reporter ${this.network}: ${firstArg}`, ...otherArgs);
  }

  public async start() {
    this.log(`info`, `started`);

    while (true) {
      try {
        await Promise.all([
          this.fetchTransfers(),
          this.fetchXReports(),
          this.fetchHeadBlockNumbers(),
        ]);
        this.printState();
        await this.reportTransfers();
        await this.executeReports();
      } catch (error) {
        this.log(`error`, extractRpcError(error));
      } finally {
        await sleep(10000);
      }
    }
  }

  async fetchTransfers() {
    const contracts = getContractsForNetwork(this.network);
    let transfers = await fetchAllRows(this.network)<TTransfersRow>({
      code: contracts.ibc,
      scope: contracts.ibc,
      table: `transfers`,
      lower_bound: Math.floor(Date.now() / 1e3),
      index_position: `2`,
      key_type: `i64`,
    });

    this.transfers = transfers.map((t) => ({
      ...t,
      id: Number.parseInt(`${t.id}`, 10),
      is_refund: Boolean(t.is_refund),
      transaction_time: new Date(`${t.transaction_time}Z`),
      expires_at: new Date(`${t.expires_at}Z`),
    }));
  }

  async fetchXReports() {
    const xChainNetwork = this.xChainNetwork;
    const contracts = getContractsForNetwork(xChainNetwork);
    const reports = await fetchAllRows(xChainNetwork)<TReportsRow>({
      code: contracts.ibc,
      scope: contracts.ibc,
      table: `reports`,
      lower_bound: Math.floor(Date.now() / 1e3),
      index_position: `3`,
      key_type: `i64`,
    });
    this.reports = reports.map((r) => ({
      ...r,
      id: Number.parseInt(`${r.id}`, 10),
    }));
  }

  async fetchHeadBlockNumbers() {
    const {
      headBlockNumber,
      lastIrreversibleBlockNumber,
    } = await fetchHeadBlockNumbers(this.network)();
    this.currentHeadBlock = headBlockNumber;
    this.currentIrreversibleHeadBlock = lastIrreversibleBlockNumber;
  }

  private async reportTransfers() {
    const unreportedTransfers = this.transfers.filter((t) => {
      const isExpired = Date.now() > t.expires_at.getTime();
      if (isExpired) return false;

      const alreadyReported = this.reports.some(
        (r) =>
          r.transfer.id === t.id &&
          r.transfer.from_blockchain === t.from_blockchain &&
          r.transfer.transaction_id === t.transaction_id
      );

      return !alreadyReported;
    });
    if (unreportedTransfers.length === 0) return;

    const irreversibleUnreportedTransfers = await this.filterTransfersByIrreversibility(
      unreportedTransfers
    );
    if (irreversibleUnreportedTransfers.length === 0) return;

    const transferToProcess = pickRandom(irreversibleUnreportedTransfers);

    const toBlockchain = transferToProcess.to_blockchain;
    if (!isNetworkName(toBlockchain))
      throw new Error(
        `Unknwon blockchain in transfer with id ${transferToProcess.id}: ${toBlockchain}`
      );

    const xcontracts = getContractsForNetwork(toBlockchain);
    try {
      const tx = await sendTransaction(toBlockchain)({
        account: xcontracts.ibc,
        name: `report`,
        authorization: [
          {
            actor: xcontracts.reporterAccount,
            permission: xcontracts.reporterPermission,
          },
        ],
        data: {
          reporter: xcontracts.reporterAccount,
          transfer: transferToProcess,
        },
      });
      this.log(
        `info`,
        `Reported transfer with id ${this.getInternalUniqueTransferId(
          transferToProcess
        )}: ${formatBloksTransaction(toBlockchain, tx.transaction_id)}`
      );
    } catch (error) {
      // const errorMessage = extractRpcError(error)
      throw error;
    }
  }

  private async executeReports() {
    const reportsToExecute = this.reports.filter((r) => {
      const reporterName = getContractsForNetwork(
        r.transfer.to_blockchain as NetworkName
      ).reporterAccount;
      return (
        r.confirmed &&
        !r.executed &&
        !r.failed &&
        !r.failed_by.includes(reporterName)
      );
    });
    if (reportsToExecute.length === 0) return;

    const reportToExecute = pickRandom(reportsToExecute);
    const toBlockchain = reportToExecute.transfer.to_blockchain;
    if (!isNetworkName(toBlockchain))
      throw new Error(
        `Unknwon blockchain in reported transfer with id ${reportToExecute.id}: ${toBlockchain}`
      );

    const xcontracts = getContractsForNetwork(toBlockchain);
    let executionFailed = false;
    try {
      const tx = await sendTransaction(toBlockchain)({
        account: xcontracts.ibc,
        name: `exec`,
        authorization: [
          {
            actor: xcontracts.reporterAccount,
            permission: xcontracts.reporterPermission,
          },
        ],
        data: {
          reporter: xcontracts.reporterAccount,
          report_id: reportToExecute.id,
        },
      });
      this.log(
        `info`,
        `Executed report-id ${
          reportToExecute.id
        } (transfer ${this.getInternalUniqueTransferId(
          reportToExecute.transfer as any
        )}): ${formatBloksTransaction(toBlockchain, tx.transaction_id)}`
      );
    } catch (error) {
      const errorMessage = extractRpcError(error);
      this.log(
        `error`,
        `Could not execute report-id ${
          reportToExecute.id
        } (transfer ${this.getInternalUniqueTransferId(
          reportToExecute.transfer as any
        )}): ${errorMessage}`
      );
      executionFailed = true;
    }

    if (!executionFailed) return;

    const tx = await sendTransaction(toBlockchain)({
      account: xcontracts.ibc,
      name: `execfailed`,
      authorization: [
        {
          actor: xcontracts.reporterAccount,
          permission: xcontracts.reporterPermission,
        },
      ],
      data: {
        reporter: xcontracts.reporterAccount,
        report_id: reportToExecute.id,
      },
    });
    this.log(
      `info`,
      `Reported failed execution for ${
        reportToExecute.id
      }: ${formatBloksTransaction(toBlockchain, tx.transaction_id)}`
    );
  }

  private async filterTransfersByIrreversibility(
    transfers: TTransfersRowTransformed[]
  ): Promise<TTransfersRowTransformed[]> {
    // because rpc.history_get_transaction is deprecated, there's no way for us to get the exact block number of when the transaction was included
    // but when we see it in RAM, the current head block is definitely past it
    transfers.forEach((t) => {
      const tId = this.getInternalUniqueTransferId(t);
      if (!this.transferIrreversibilityMap[tId]) {
        const txInfo = `${t.from_account}@${t.from_blockchain} == ${t.quantity} ==> ${t.to_account}@${t.to_blockchain}`;
        this.log(
          `verbose`,
          `Saw new transaction ${tId} (${t.transaction_id}) at block ${this.currentHeadBlock}\n${txInfo}`
        );
        this.transferIrreversibilityMap[tId] = this.currentHeadBlock;
      }
    });
    // TODO: change this to currentIrreversibleHeadBlock > ...
    return transfers.filter(
      (t) =>
        this.currentHeadBlock >
          this.transferIrreversibilityMap[
            this.getInternalUniqueTransferId(t)
          ] || Infinity
    );
  }

  private getInternalUniqueTransferId(transfer: TTransfersRowTransformed) {
    return `${transfer.from_blockchain}|${transfer.id}`;
  }

  private get xChainNetwork(): NetworkName {
    switch (this.network) {
      case `eos`:
        return `wax`;
      case `wax`:
        return `eos`;
      default: {
        throw new Error(
          `xChainNetwork: Unknown current network ${this.network}`
        );
      }
    }
  }

  private printState() {
    // this.log(`verbose`, `tranfers:`, this.transfers);
    // this.log(`verbose`, `reports:`, this.reports);
    // this.log(
    //   `verbose`,
    //   `headBlock: ${this.currentHeadBlock} irreversible: ${this.currentIrreversibleHeadBlock}`
    // );
  }
}