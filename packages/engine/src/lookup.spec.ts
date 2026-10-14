import { describe, expect, it } from 'vitest';
import { extractAddress } from './lookup';

describe('extractAddress', () => {
  it('finds an EVM address anywhere in a message, lowercased', () => {
    expect(extractAddress('check 0x6982508145454Ce325dDbE47a25d4ec3d2311933 pls')).toEqual({ family: 'evm', address: '0x6982508145454ce325ddbe47a25d4ec3d2311933' });
    expect(extractAddress('https://basescan.org/token/0x4200000000000000000000000000000000000006')?.address).toBe('0x4200000000000000000000000000000000000006');
  });
  it('finds a Solana mint, keeping its case (base58 is case-sensitive)', () => {
    expect(extractAddress('7U3AW1gVRDcc9okYGGycJX1jjve21nhXqnSbXk9kpump')).toEqual({ family: 'solana', address: '7U3AW1gVRDcc9okYGGycJX1jjve21nhXqnSbXk9kpump' });
    expect(extractAddress('https://pump.fun/coin/7U3AW1gVRDcc9okYGGycJX1jjve21nhXqnSbXk9kpump')?.address).toBe('7U3AW1gVRDcc9okYGGycJX1jjve21nhXqnSbXk9kpump');
  });
  it('ignores ordinary text and long numbers', () => {
    expect(extractAddress('gm, what is pumping today?')).toBeNull();
    expect(extractAddress('12345678901234567890123456789012345')).toBeNull();
  });
});
