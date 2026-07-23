import { NextRequest, NextResponse } from "next/server";
import { Interface } from "ethers";

import {
  type OracleModule,
  type ParsedOracleReport,
  parseOracleReport,
} from "../../oracle-reports";

type NetworkKey = "mainnet" | "hoodi";

type RpcResponse<T> = {
  id: number;
  result?: T;
  error?: { message?: string };
};

const CONFIG = {
  mainnet: {
    explorer: "https://etherscan.io",
    stakingRouter: "0xFdDf38947aFB03C621C71b06C9C70bce73f12999",
    rpcs: [
      "https://ethereum.publicnode.com",
      "https://eth-mainnet.g.alchemy.com/v2/demo",
    ],
    contracts: {
      ao: "0x852deD011285fe67063a08005c71a85690503Cee",
      vebo: "0x0De4Ea0184c2ad0BacA7183356Aea5B8d5Bf5c6e",
      csm: "0x4D4074628678Bd302921c20573EEa1ed38DdF7FB",
      cm: "0x8EeFCdbD984c30E472BcbF545783D051CB5114e5",
    },
  },
  hoodi: {
    explorer: "https://hoodi.etherscan.io",
    stakingRouter: "0xCc820558B39ee15C7C45B59390B503b83fb499A8",
    rpcs: [
      "https://rpc.hoodi.ethpandaops.io",
      "https://ethereum-hoodi-rpc.publicnode.com",
    ],
    contracts: {
      ao: "0xcb883B1bD0a41512b42D2dB267F2A2cd919FB216",
      vebo: "0x8664d394C2B3278F26A1B44B967aEf99707eeAB2",
      csm: "0xe7314f561B2e72f9543F1004e741bab6Fc51028B",
      cm: "0x5D2F27000C80f6f7A03015Fd49dB7FEba3fBfa83",
    },
  },
} as const;

const PROCESSING_STARTED_TOPIC =
  "0xf73febded7d4502284718948a3e1d75406151c6326bde069424a584a4f6af87a";

const STAKING_ROUTER = new Interface([
  "function getStakingModule(uint256) view returns ((uint24 id,address stakingModuleAddress,uint16 stakingModuleFee,uint16 treasuryFee,uint16 stakeShareLimit,uint8 status,string name,uint64 lastDepositAt,uint256 lastDepositBlock,uint256 exitedValidatorsCount,uint16 priorityExitShareThreshold,uint64 maxDepositsPerBlock,uint64 minDepositBlockDistance))",
]);
const LEGACY_OPERATOR = new Interface([
  "function getNodeOperator(uint256,bool) view returns (bool active,string name,address rewardAddress,uint64 totalVettedValidators,uint64 totalExitedValidators,uint64 totalAddedValidators,uint64 totalDepositedValidators)",
]);
const CURATED_MODULE = new Interface([
  "function META_REGISTRY() view returns (address)",
]);
const META_REGISTRY = new Interface([
  "function getOperatorMetadata(uint256) view returns ((string name,string description,bool ownerEditsRestricted))",
]);

async function explorerHashes(explorer: string, address: string) {
  const response = await fetch(`${explorer}/address/${address}`, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; LidoOracleWatch/1.0; +https://lido.fi)",
    },
    next: { revalidate: 300 },
  });
  if (!response.ok) throw new Error(`Explorer returned ${response.status}`);
  const html = await response.text();
  const hashes = [
    ...html.matchAll(/href=["']\/tx\/(0x[a-fA-F0-9]{64})/g),
  ].map((match) => match[1].toLowerCase());
  return [...new Set(hashes)].slice(0, 40);
}

async function rpcBatch<T>(
  rpcs: readonly string[],
  method: string,
  params: unknown[][],
) {
  let lastError: unknown;
  for (const rpc of rpcs) {
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          params.map((item, index) => ({
            jsonrpc: "2.0",
            id: index + 1,
            method,
            params: item,
          })),
        ),
      });
      if (!response.ok) throw new Error(`RPC returned ${response.status}`);
      const payload = (await response.json()) as RpcResponse<T>[];
      if (!Array.isArray(payload)) throw new Error("RPC rejected batch request");
      const byId = new Map(payload.map((item) => [item.id, item]));
      return params.map((_, index) => byId.get(index + 1)?.result ?? null);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("No RPC endpoint responded");
}

async function rpcReportCandidates(
  rpcs: readonly string[],
  contracts: Record<OracleModule, string>,
) {
  const [latestHex] = await rpcBatch<string>(rpcs, "eth_blockNumber", [[]]);
  if (!latestHex) throw new Error("Latest block was unavailable");
  const latest = Number.parseInt(latestHex, 16);
  const fromBlock = Math.max(0, latest - 250_000);
  const ranges: unknown[][] = [];
  for (let from = fromBlock; from <= latest; from += 10_000) {
    ranges.push([
      {
        address: Object.values(contracts),
        topics: [PROCESSING_STARTED_TOPIC],
        fromBlock: `0x${from.toString(16)}`,
        toBlock: `0x${Math.min(latest, from + 9_999).toString(16)}`,
      },
    ]);
  }
  const results = await rpcBatch<
    Array<{ address: string; transactionHash: string }>
  >(rpcs, "eth_getLogs", ranges);
  const moduleByAddress = new Map(
    (Object.entries(contracts) as Array<[OracleModule, string]>).map(
      ([module, address]) => [address.toLowerCase(), module],
    ),
  );
  const candidates = results.flatMap((logs) =>
    (logs ?? []).flatMap((log) => {
      const reportModule = moduleByAddress.get(log.address.toLowerCase());
      return reportModule
        ? [
            {
              hash: log.transactionHash.toLowerCase(),
              module: reportModule,
              address: contracts[reportModule],
            },
          ]
        : [];
    }),
  );
  return (Object.keys(contracts) as OracleModule[]).flatMap((reportModule) =>
    candidates
      .filter((candidate) => candidate.module === reportModule)
      .slice(-40),
  );
}

async function resolveVeboOperatorNames(
  rpcs: readonly string[],
  stakingRouter: string,
  reports: ParsedOracleReport[],
) {
  const operators = new Map<
    string,
    NonNullable<ParsedOracleReport["veboOperators"]>[number][]
  >();
  for (const report of reports) {
    for (const operator of report.veboOperators ?? []) {
      const key = `${operator.moduleId}:${operator.operatorId}`;
      operators.set(key, [...(operators.get(key) ?? []), operator]);
    }
  }
  if (!operators.size) return;

  const moduleIds = [
    ...new Set(
      [...operators.keys()].map((key) => Number.parseInt(key.split(":")[0], 10)),
    ),
  ];
  const moduleResults = await rpcBatch<string>(
    rpcs,
    "eth_call",
    moduleIds.map((moduleId) => [
      {
        to: stakingRouter,
        data: STAKING_ROUTER.encodeFunctionData("getStakingModule", [moduleId]),
      },
      "latest",
    ]),
  );
  const moduleAddresses = new Map<number, string>();
  moduleResults.forEach((result, index) => {
    if (!result) return;
    try {
      const moduleState = STAKING_ROUTER.decodeFunctionResult(
        "getStakingModule",
        result,
      )[0];
      moduleAddresses.set(moduleIds[index], moduleState.stakingModuleAddress);
    } catch {
      // A missing module should not prevent the report itself from rendering.
    }
  });

  const entries = [...operators.entries()].flatMap(([key, instances]) => {
    const [moduleId, operatorId] = key.split(":");
    const moduleAddress = moduleAddresses.get(Number.parseInt(moduleId, 10));
    return moduleAddress
      ? [{ key, moduleAddress, operatorId, instances }]
      : [];
  });
  const legacyResults = await rpcBatch<string>(
    rpcs,
    "eth_call",
    entries.map(({ moduleAddress, operatorId }) => [
      {
        to: moduleAddress,
        data: LEGACY_OPERATOR.encodeFunctionData("getNodeOperator", [
          operatorId,
          true,
        ]),
      },
      "latest",
    ]),
  );

  const unresolved = entries.filter((entry, index) => {
    const result = legacyResults[index];
    if (!result) return true;
    try {
      const name = LEGACY_OPERATOR.decodeFunctionResult(
        "getNodeOperator",
        result,
      ).name as string;
      if (!name) return true;
      entry.instances.forEach((operator) => {
        operator.operatorName = name;
      });
      return false;
    } catch {
      return true;
    }
  });
  if (!unresolved.length) return;

  const registryResults = await rpcBatch<string>(
    rpcs,
    "eth_call",
    unresolved.map(({ moduleAddress }) => [
      {
        to: moduleAddress,
        data: CURATED_MODULE.encodeFunctionData("META_REGISTRY"),
      },
      "latest",
    ]),
  );
  const metadataEntries = unresolved.flatMap((entry, index) => {
    const result = registryResults[index];
    if (!result) return [];
    try {
      const registry = CURATED_MODULE.decodeFunctionResult(
        "META_REGISTRY",
        result,
      )[0] as string;
      return [{ ...entry, registry }];
    } catch {
      return [];
    }
  });
  const metadataResults = await rpcBatch<string>(
    rpcs,
    "eth_call",
    metadataEntries.map(({ registry, operatorId }) => [
      {
        to: registry,
        data: META_REGISTRY.encodeFunctionData("getOperatorMetadata", [
          operatorId,
        ]),
      },
      "latest",
    ]),
  );
  metadataResults.forEach((result, index) => {
    if (!result) return;
    try {
      const metadata = META_REGISTRY.decodeFunctionResult(
        "getOperatorMetadata",
        result,
      )[0];
      if (!metadata.name) return;
      metadataEntries[index].instances.forEach((operator) => {
        operator.operatorName = metadata.name;
      });
    } catch {
      // Some staking modules intentionally expose no operator names.
    }
  });

  for (const report of reports) {
    if (!report.veboOperators) continue;
    report.rawJson = JSON.stringify(
      {
        fields: Object.fromEntries(
          report.fields.map((field) => [field.label, field.value]),
        ),
        operators: report.veboOperators,
      },
      null,
      2,
    );
  }
}

export async function GET(request: NextRequest) {
  const network = request.nextUrl.searchParams.get("network") as NetworkKey;
  if (network !== "mainnet" && network !== "hoodi") {
    return NextResponse.json(
      { error: "network must be mainnet or hoodi" },
      { status: 400 },
    );
  }

  const config = CONFIG[network];
  try {
    const discovered = await Promise.all(
      (Object.entries(config.contracts) as Array<[OracleModule, string]>).map(
        async ([module, address]) => {
          try {
            const hashes = await explorerHashes(config.explorer, address);
            return hashes.map((hash) => ({ hash, module, address }));
          } catch {
            return [];
          }
        },
      ),
    );
    let candidates = discovered.flat();
    if (!candidates.length) {
      candidates = await rpcReportCandidates(config.rpcs, config.contracts);
    }
    if (!candidates.length) {
      throw new Error("No recent contract transactions were available");
    }

    const uniqueHashes = [...new Set(candidates.map(({ hash }) => hash))];
    const transactions = await rpcBatch<{
      hash: string;
      from: string;
      to: string;
      input: string;
      blockNumber: string;
    }>(config.rpcs, "eth_getTransactionByHash", uniqueHashes.map((hash) => [hash]));
    const candidateByHash = new Map(
      candidates.map((candidate) => [candidate.hash, candidate]),
    );
    const reportTransactions = transactions.flatMap((transaction) => {
      if (!transaction?.to) return [];
      const candidate = candidateByHash.get(transaction.hash.toLowerCase());
      if (
        !candidate ||
        transaction.to.toLowerCase() !== candidate.address.toLowerCase()
      ) {
        return [];
      }
      return [{ transaction, module: candidate.module }];
    });

    const blockNumbers = [
      ...new Set(
        reportTransactions.map(({ transaction }) => transaction.blockNumber),
      ),
    ];
    const blocks = await rpcBatch<{ timestamp: string }>(
      config.rpcs,
      "eth_getBlockByNumber",
      blockNumbers.map((block) => [block, false]),
    );
    const timestampByBlock = new Map(
      blockNumbers.map((block, index) => [
        block,
        blocks[index] ? Number.parseInt(blocks[index]!.timestamp, 16) : 0,
      ]),
    );

    const reports = reportTransactions
      .map(({ transaction, module }) =>
        parseOracleReport(
          module,
          transaction,
          timestampByBlock.get(transaction.blockNumber) ?? 0,
        ),
      )
      .filter((report) => report !== null)
      .sort((a, b) => b.blockNumber - a.blockNumber);
    await resolveVeboOperatorNames(
      config.rpcs,
      config.stakingRouter,
      reports,
    );

    return NextResponse.json(
      {
        network,
        contracts: config.contracts,
        reports,
      },
      {
        headers: {
          "Cache-Control": "public, max-age=60, s-maxage=300",
        },
      },
    );
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to load oracle reports",
      },
      { status: 502 },
    );
  }
}
