import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import { Program, AnchorProvider, Wallet } from "@coral-xyz/anchor";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

const RPC_URL = process.env.SOLANA_RPC_URL || "http://127.0.0.1:8899";
const WS_URL = process.env.SOLANA_WS_URL || "ws://127.0.0.1:8900";
const PROGRAM_ID = new PublicKey(
  process.env.BOREAL_PROGRAM_ID || "BoreAL1111111111111111111111111111111111111"
);
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || "";
const ENTERPRISE_AUDIT_EMAIL = process.env.ENTERPRISE_AUDIT_EMAIL || "finance@corp-client.pl";

// Minimal IDL definition for events
const IDL: any = {
  version: "0.1.0",
  name: "boreal_escrow",
  instructions: [],
  events: [
    {
      name: "EscrowInitializedEvent",
      fields: [
        { name: "escrowId", type: "u64", index: false },
        { name: "payer", type: "publicKey", index: false },
        { name: "contractor", type: "publicKey", index: false },
        { name: "arbiter", type: "publicKey", index: false },
        { name: "amount", type: "u64", index: false },
        { name: "deadline", type: "i64", index: false },
      ],
    },
    {
      name: "FundsReleasedEvent",
      fields: [
        { name: "escrowId", type: "u64", index: false },
        { name: "contractor", type: "publicKey", index: false },
        { name: "amount", type: "u64", index: false },
        { name: "completedAt", type: "i64", index: false },
      ],
    },
  ],
};

export class BorealEnterpriseAgent {
  private connection: Connection;
  private program: Program;

  constructor() {
    this.connection = new Connection(RPC_URL, {
      wsEndpoint: WS_URL,
      commitment: "confirmed",
    });
    const dummyKeypair = Keypair.generate();
    const provider = new AnchorProvider(
      this.connection,
      new Wallet(dummyKeypair),
      { commitment: "confirmed" }
    );
    this.program = new Program(IDL, PROGRAM_ID, provider);
  }

  public async start(): Promise<void> {
    console.log(`[Boreal-Agent] Starting listener on ${RPC_URL}`);
    console.log(`[Boreal-Agent] Monitoring Program ID: ${PROGRAM_ID.toBase58()}`);

    // Listen for On-Chain Escrow Initialization
    this.program.addEventListener("EscrowInitializedEvent", async (event: any, slot: number) => {
      console.log(`[EVENT] EscrowInitialized: ID #${event.escrowId.toString()} at slot ${slot}`);
      await this.notifySlack(
        `:lock: *Boreal Escrow Deposited* | Escrow ID #${event.escrowId.toString()}\n` +
        `• Payer: \`${event.payer.toBase58()}\`\n` +
        `• Amount: \`${(event.amount.toNumber() / 1_000_000).toFixed(2)} USDC/EURC\`\n` +
        `• Deadline: ${new Date(event.deadline.toNumber() * 1000).toISOString()}`
      );
    });

    // Listen for On-Chain Settlement Release
    this.program.addEventListener("FundsReleasedEvent", async (event: any, slot: number) => {
      console.log(`[EVENT] FundsReleased: ID #${event.escrowId.toString()} at slot ${slot}`);
      const formattedAmount = (event.amount.toNumber() / 1_000_000).toFixed(2);

      await Promise.all([
        this.notifySlack(
          `:white_check_mark: *Milestone Approved & Settled* | Escrow ID #${event.escrowId.toString()}\n` +
          `• Recipient: \`${event.contractor.toBase58()}\`\n` +
          `• Disbursed: \`${formattedAmount} USDC/EURC\`\n` +
          `• Timestamp: ${new Date(event.completedAt.toNumber() * 1000).toISOString()}`
        ),
        this.sendResendInvoiceEmail({
          escrowId: event.escrowId.toString(),
          contractor: event.contractor.toBase58(),
          amount: formattedAmount,
          settledAt: new Date(event.completedAt.toNumber() * 1000).toISOString(),
        }),
      ]);
    });
  }

  private async notifySlack(message: string): Promise<void> {
    if (!SLACK_WEBHOOK_URL) {
      console.log(`[Alert-Simulated] Slack: ${message}`);
      return;
    }
    try {
      await axios.post(SLACK_WEBHOOK_URL, { text: message });
    } catch (err: any) {
      console.error(`[Slack-Error] Failed to dispatch webhook:`, err.message);
    }
  }

  private async sendResendInvoiceEmail(invoice: {
    escrowId: string;
    contractor: string;
    amount: string;
    settledAt: string;
  }): Promise<void> {
    if (!RESEND_API_KEY) {
      console.log(`[Invoice-Simulated] Resend Email to ${ENTERPRISE_AUDIT_EMAIL}:`, invoice);
      return;
    }
    try {
      await axios.post(
        "https://api.resend.com/emails",
        {
          from: "settlement@boreal.superteam.pl",
          to: [ENTERPRISE_AUDIT_EMAIL],
          subject: `[INVOICE ATTESTATION] Escrow #${invoice.escrowId} Settled`,
          html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #222;">
              <h2>Boreal Protocol - Cryptographic Settlement Voucher</h2>
              <p>This automated tax attestation confirms settlement completion on Solana.</p>
              <hr/>
              <table style="width: 100%; text-align: left;">
                <tr><th>Escrow ID:</th><td>#${invoice.escrowId}</td></tr>
                <tr><th>Recipient Address:</th><td><code>${invoice.contractor}</code></td></tr>
                <tr><th>Net Disbursed:</th><td><strong>${invoice.amount} Token Units</strong></td></tr>
                <tr><th>Settlement Finality:</th><td>${invoice.settledAt}</td></tr>
              </table>
              <hr/>
              <p style="font-size: 12px; color: #777;">
                Verified by Boreal Solana Core Engine. Compliant with EU electronic commercial proof regulations.
              </p>
            </div>
          `,
        },
        {
          headers: {
            Authorization: `Bearer ${RESEND_API_KEY}`,
            "Content-Type": "application/json",
          },
        }
      );
      console.log(`[Resend-Success] Invoice email dispatched for Escrow #${invoice.escrowId}`);
    } catch (err: any) {
      console.error(`[Resend-Error] Failed to send email invoice:`, err.response?.data || err.message);
    }
  }
}

// Headless runtime launch
if (require.main === module) {
  const agent = new BorealEnterpriseAgent();
  agent.start().catch((err) => {
    console.error("[Fatal-Agent-Crash]", err);
    process.exit(1);
  });
}