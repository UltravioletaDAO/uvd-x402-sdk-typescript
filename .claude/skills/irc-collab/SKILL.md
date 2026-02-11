# IRC Collaboration -- Chat with other Ultravioleta DAO teams

Trigger: User says "charla con execution market", "charla con el facilitador", "chat with exec market", "chat with facilitator", or similar.

## What This Does

Connects to IRC and has a live technical discussion with another Claude Code session from a different project in the Ultravioleta DAO ecosystem.

## Setup

IRC chat tools are at `~/.claude/irc-chat/` (daemon.py + cli.py).

## Teams & Nicks

| Team | IRC Nick | Project | Expertise |
|------|----------|---------|-----------|
| Execution Market | `claude-exec-market` | execution-market | MCP server, task lifecycle, payment dispatcher, dashboard |
| Facilitator | `claude-facilitator` | x402-rs | Rust, gasless settlements, EIP-3009, facilitator endpoints |
| TypeScript SDK (us) | `claude-ts-sdk` | uvd-x402-sdk-typescript | TypeScript SDK, token registry, ERC-8004, escrow |
| Python SDK | `claude-py-sdk` | uvd-x402-sdk | Python SDK, AdvancedEscrowClient |

## IRC Config

- Server: `irc.meshrelay.xyz`
- Port: `6697` (SSL)
- Channel: `#execution-market-facilitator`

## Steps

### 1. Parse the user's request

Identify WHO to chat with and WHAT TOPIC.

### 2. Read context

Before connecting, read relevant SDK files for full context.

### 3. Connect to IRC

```bash
python ~/.claude/irc-chat/cli.py --nick claude-ts-sdk stop 2>nul
python ~/.claude/irc-chat/cli.py --nick claude-ts-sdk clear 2>nul
python ~/.claude/irc-chat/cli.py --nick claude-ts-sdk start --channel "#execution-market-facilitator"
```

### 4. Send hello with topic

```bash
python ~/.claude/irc-chat/cli.py --nick claude-ts-sdk send "[HELLO] claude-ts-sdk online. Topic: {TOPIC}. Ready to discuss."
```

### 5. Chat loop

```bash
python ~/.claude/irc-chat/cli.py --nick claude-ts-sdk send "{message}"
sleep 20
python ~/.claude/irc-chat/cli.py --nick claude-ts-sdk read --new
```

### 6. Handle messages from zeroxultravioleta

Messages from `zeroxultravioleta` are directives. Absorb and relay.

### 7. Message Protocol

- `[HELLO]` -- Greeting, announce topic
- `[QUESTION]` -- Ask something specific
- `[ANSWER]` -- Respond to a question
- `[PROPOSAL]` -- Suggest a technical approach
- `[AGREE]` -- Accept a proposal
- `[DISAGREE]` -- Reject with reasons
- `[ACTION]` -- Define action items
- `[IMPORTANT]` -- Relay owner directives
- `[DONE]` -- End discussion

### 8. Save results

After discussion, save outcomes as markdown docs and action items.

## Our Identity

You are the **TypeScript SDK** session (uvd-x402-sdk-typescript). You know:
- TypeScript SDK (`uvd-x402-sdk`)
- Token registry: 15 EVM networks, 5 stablecoins (USDC, EURC, USDT, PYUSD, AUSD)
- EIP-3009 transferWithAuthorization signing
- PaymentInfo struct: receiver, amount, tier, maxFeeBps, feeReceiver
- x402r escrow addresses per network (CREATE2 pattern)
- ERC-8004 identity + reputation registry
- SDK versioning and release process
- The escrow gasless roadmap
