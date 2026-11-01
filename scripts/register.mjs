// Registers Pecos on Telegraph (Ethereum Sepolia). Stops at the first failure.
// Run with viem available and PECOS_EVM_PRIVATE_KEY set.
import { createHash } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

const RPC = "https://ethereum-sepolia-rpc.publicnode.com";
const DIAMOND = "0x3624EB012B5E998BB57B6bE6C9Cfc9c4bc5eb99b";
const USDC = "0xcc194e1a843B658526D0D5C431f670028582Ae17";
const MACHINA = "0xd68305cA83C7AF42A4F720144E7416fB53F8AaF4";
const ROUTER = "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E";
const YAML_URL = "https://pecos-app.up.railway.app/pecos.yaml";
const INTENTS = ["GRID_POWER_PRICE_GENERAL"];
const MIN_PRICE = 10_000n;

const erc20 = parseAbi([
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const router = parseAbi([
  "struct Params { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(Params params) payable returns (uint256)",
]);
const diamond = parseAbi([
  "function registerMiner(string yamlUrl, bytes32 yamlHash, address feeAddress, uint256 minPriceUsdc, string[] supportedIntents) returns (uint256)",
]);

const account = privateKeyToAccount(process.env.PECOS_EVM_PRIVATE_KEY);
const transport = http(RPC);
const pub = createPublicClient({ chain: sepolia, transport });
const wallet = createWalletClient({ account, chain: sepolia, transport });

async function confirm(label, hash) {
  const receipt = await pub.waitForTransactionReceipt({ hash });
  console.log(label, receipt.status, hash);
  if (receipt.status !== "success") throw new Error(`${label} failed`);
}
const balance = (address) =>
  pub.readContract({ address, abi: erc20, functionName: "balanceOf", args: [account.address] });

const yaml = Buffer.from(await (await fetch(YAML_URL)).arrayBuffer());
const yamlHash = `0x${createHash("sha256").update(yaml).digest("hex")}`;
console.log("yaml hash", yamlHash);

if ((await balance(MACHINA)) < 10n ** 18n) {
  if ((await balance(USDC)) < 2_000_000n) {
    await confirm("mint usdc", await wallet.writeContract({ address: USDC, abi: erc20, functionName: "mint", args: [account.address, 5_000_000n] }));
  }
  await confirm("approve router", await wallet.writeContract({ address: USDC, abi: erc20, functionName: "approve", args: [ROUTER, 2_000_000n] }));
  await confirm(
    "swap",
    await wallet.writeContract({
      address: ROUTER,
      abi: router,
      functionName: "exactInputSingle",
      args: [{ tokenIn: USDC, tokenOut: MACHINA, fee: 3000, recipient: account.address, amountIn: 2_000_000n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
    }),
  );
}
console.log("machina", formatEther(await balance(MACHINA)));

await confirm("approve bond", await wallet.writeContract({ address: MACHINA, abi: erc20, functionName: "approve", args: [DIAMOND, 2n * 10n ** 18n] }));

const args = [YAML_URL, yamlHash, account.address, MIN_PRICE, INTENTS];
const { result } = await pub.simulateContract({ account, address: DIAMOND, abi: diamond, functionName: "registerMiner", args });
console.log("dry run ok, registration id", String(result));

await confirm("register", await wallet.writeContract({ address: DIAMOND, abi: diamond, functionName: "registerMiner", args }));

console.log("machina", formatEther(await balance(MACHINA)), "usdc", formatUnits(await balance(USDC), 6));
console.log("eth", formatEther(await pub.getBalance({ address: account.address })));
