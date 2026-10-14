import { describe, expect, it } from 'vitest';
import { classifyLaunchpad, launchpadForDex } from './launchpads';

describe('launchpads', () => {
  it('reads the launchpad from either provider’s dex id', () => {
    expect(launchpadForDex('solana', 'pump-fun')?.id).toBe('pumpfun'); // GeckoTerminal
    expect(launchpadForDex('solana', 'pumpfun')?.id).toBe('pumpfun'); // DEX Screener
    expect(launchpadForDex('robinhood', 'pons-v2')?.id).toBe('pons');
    expect(launchpadForDex('base', 'pump-fun')).toBeUndefined(); // wrong chain
  });

  it('curve while only on the launchpad venue, graduated once a migration pool exists', () => {
    expect(classifyLaunchpad('solana', 'Abcpump', ['pumpfun'])).toEqual({ launchpad: 'pumpfun', stage: 'curve', evidence: 'dex' });
    expect(classifyLaunchpad('solana', 'Abcpump', ['pumpfun', 'pumpswap'])).toEqual({ launchpad: 'pumpfun', stage: 'graduated', evidence: 'dex' });
    expect(classifyLaunchpad('bsc', '0xabcffff', ['four-meme', 'pancakeswap_v2'])?.stage).toBe('graduated');
  });

  it('address suffix identifies the launchpad; graduation still needs the pool', () => {
    expect(classifyLaunchpad('solana', 'Xyzpump', ['pumpswap'])).toEqual({ launchpad: 'pumpfun', stage: 'graduated', evidence: 'address' });
    expect(classifyLaunchpad('solana', 'Xyzpump', ['raydium'])).toEqual({ launchpad: 'pumpfun', stage: 'launched', evidence: 'address' });
  });

  it('no evidence → null (unknown, not "not a launchpad token")', () => {
    expect(classifyLaunchpad('solana', 'So11111111111111111111111111111111111111112', ['raydium', 'orca'])).toBeNull();
    // A pancakeswap pool alone is not four.meme graduation.
    expect(classifyLaunchpad('bsc', '0x55d398326f99059ff775485246999027b3197955', ['pancakeswap'])).toBeNull();
  });

  it('launchpads without a graduation step report "launched"', () => {
    expect(classifyLaunchpad('base', '0xabc', ['zora'])?.stage).toBe('launched');
  });
});
