// Using viem with Deno compatibile import
import { 
  createPublicClient, 
  http, 
  formatUnits, 
  encodeFunctionData,
  parseAbi,
} from 'viem';

import type { 
  PublicClient,
  Address,
  Hex
} from 'viem';

// Define the types here instead of importing them
export interface TokenInfo {
  address: string;
  symbol?: string;
  decimals?: number;
}

export interface TokenBalance {
  address: string;
  symbol?: string;
  balance: bigint;
  decimals?: number;
  formattedBalance?: string;
}

export interface MultiCallOptions {
  formatBalances?: boolean;
  customAbi?: any[];
  methodName?: string;
  methodParams?: any[];
}

export interface CallData {
  target: string;
  callData: string;
}

export interface BalanceQueryResult {
  walletAddress: string;
  blockNumber?: bigint;
  balances: TokenBalance[];
}

// Hyperliquid-specific constants
export const HYPERLIQUID_RPC_URLS = {
  MAINNET: 'https://rpc.hyperliquid.xyz/evm',
  TESTNET: 'https://rpc.hyperliquid-testnet.xyz/evm',
};
export const HYPERLIQUID_MULTICALL_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

// ERC20 ABI (minimal, just for balanceOf)
const erc20Abi = parseAbi([
  'function balanceOf(address _owner) view returns (uint256 balance)',
]);

// Multicall ABI (minimal, just for aggregate)
const multicallAbi = parseAbi([
  'function aggregate((address target, bytes callData)[] calls) view returns (uint256 blockNumber, bytes[] returnData)',
  'function getEthBalance(address addr) view returns (uint256)',
]);

export class MulticallClient {
  private client: PublicClient;

  /**
   * Create a new MulticallClient for Hyperliquid chain
   * @param isTestnet Whether to use testnet environment
   */
  constructor(isTestnet: boolean = false) {
    const rpcUrl = isTestnet ? HYPERLIQUID_RPC_URLS.TESTNET : HYPERLIQUID_RPC_URLS.MAINNET;
    this.client = createPublicClient({
      transport: http(rpcUrl),
    });
  }

  /**
   * Get balances for multiple tokens on Hyperliquid in a single multicall
   *
   * @param walletAddress - The wallet address to check balances for
   * @param tokens - Array of token contracts to check
   * @param options - Optional configuration
   * @returns A promise resolving to balance data
   */
  public async getTokenBalances(
    walletAddress: string,
    tokens: TokenInfo[],
  ): Promise<BalanceQueryResult> {
    try {
      // Set defaults
      const methodParams = walletAddress;

      // Get multicall contract
      const multicallContract = {
        address: HYPERLIQUID_MULTICALL_ADDRESS as Address,
        abi: multicallAbi
      };

      // Prepare calldata for token balances
      const callData = this.prepareCalldata(tokens, methodParams);

      // Execute multicall
      const result = await this.client.readContract({
        ...multicallContract,
        functionName: 'aggregate',
        args: [callData]
      });
      
      const blockNumber = result[0]; // First result item is blockNumber
      const returnData = result[1]; // Second result item is returnData array

      // Process balances
      const balances: TokenBalance[] = [];
      for (let i = 0; i < tokens.length; i++) {
        try {
          const token = tokens[i];
          const data = returnData[i];

          // Skip empty data or handle it properly
          if (!data || data === '0x' ) {
            balances.push({
              address: token.address,
              symbol: token.symbol,
              balance: BigInt(0),
              decimals: token.decimals,
              formattedBalance: '0',
            });
            continue;
          }

          // Convert hex to BigInt
          const hexValue = data.startsWith('0x') ? data : `0x${data}`;
          let balance;
          try {
            balance = BigInt(hexValue);
          } catch (err) {
            // If BigInt conversion fails, fallback to zero
            balance = BigInt(0);
          }

          // Format balance if requested and decimals provided
          let formattedBalance;
          if (token.decimals !== undefined) {
            formattedBalance = formatUnits(balance, token.decimals);
          }

          balances.push({
            address: token.address,
            symbol: token.symbol,
            balance,
            decimals: token.decimals,
            formattedBalance,
          });
        } catch (error) {
          // Quietly handle errors without console logs to avoid issues in React Native
          balances.push({
            address: tokens[i].address,
            symbol: tokens[i].symbol,
            balance: BigInt(0),
            decimals: tokens[i].decimals,
            formattedBalance: '0',
          });
        }
      }

      return {
        walletAddress,
        blockNumber,
        balances,
      };
    } catch (error) {
      // Quietly handle errors without console logs to avoid issues in React Native
      return {
        walletAddress,
        balances: [],
      };
    }
  }

  /**
   * Get native HYPE token balance for a wallet
   * @param walletAddress The wallet address to check balance for
   * @returns The balance as a TokenBalance object
   */
  public async getNativeBalance(walletAddress: string): Promise<TokenBalance> {
    try {
      // Use multicall's getEthBalance to get the native token balance
      const result = await this.client.readContract({
        address: HYPERLIQUID_MULTICALL_ADDRESS as Address,
        abi: multicallAbi,
        functionName: 'getEthBalance',
        args: [walletAddress as Address]
      });
      
      const balance = BigInt(result || 0);

      // Format the balance to 18 decimals (native token standard)
      const formattedBalance = formatUnits(balance, 18);

      return {
        address: '0x0000000000000000000000000000000000000000', // Zero address for native token
        symbol: 'HYPE',
        balance,
        decimals: 18,
        formattedBalance,
      };
    } catch (error) {
      // Return zero balance on error
      return {
        address: '0x0000000000000000000000000000000000000000',
        symbol: 'HYPE',
        balance: BigInt(0),
        decimals: 18,
        formattedBalance: '0',
      };
    }
  }

  /**
   * Prepare calldata for multicall contract
   */
  private prepareCalldata(
    tokens: TokenInfo[],
    methodParams: string,
  ): { target: Address; callData: Hex }[] {
    // Use custom ABI if provided, otherwise use ERC20 ABI
    const abi = erc20Abi;
    
    // Encode the function call
    const encodedCalldata = encodeFunctionData({
      abi,
      functionName: "balanceOf",
      args: [methodParams as `0x${string}`] // Type assertion for viem's hex string requirement
    });

    // Create call data for each token
    return tokens.map(token => ({
      target: token.address as Address,
      callData: encodedCalldata,
    }));
  }
}
