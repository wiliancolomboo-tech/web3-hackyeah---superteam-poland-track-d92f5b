import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import axios from "axios";
import * as dotenv from "dotenv";

dotenv.config();

interface ResendPayload {
  from: string;
  to: string[];
  subject: string;
  html: string;
}

export class EnterpriseSentinel {
  private connection: Connection;
  private programId: PublicKey;
  private resendApiKey: string;
  private enterpriseSlackWebhook: string;
  private recipientAuditEmail: string;

  constructor() {
    const rpcUrl = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
    const wsUrl = process.env.SOLANA_WSS_URL || "wss://api.devnet.solana.com";
    this.connection = new Connection(rpcUrl, { wsEndpoint: wsUrl, commitment: "confirmed" });
    this.programId = new PublicKey(
      process.env.PROGRAM_ID || "Kop1111111111111111111111111111111111111111"
    );
    this.resendApiKey = process.env.RESEND_API_KEY || "";
    this.enterpriseSlackWebhook = process.env.SLACK_WEBHOOK_URL || "";
    this.recipientAuditEmail = process.env.AUDIT_EMAIL || "treasury@enterprise.eu";

    console.log(`[INIT] Kopernik Sentinel initialized for Program: ${this.programId.toBase58()}`);
  }

  public async notifySlack(title: string, details: Record<string, any>): Promise<void> {
    if (!this.enterpriseSlackWebhook) {
      console.warn("[ALERT] Slack webhook URL not configured, skipping HTTP dispatch.");
      return;
    }

    const payload = {
      text: `*Kopernik Protocol Alert: ${title}*`,
      blocks: [
        {
          type: "header",
          text: { type: "plain_text", text: `🛡️ Kopernik Protocol: ${title}` },
        },
        {
          type: "section",
          fields: Object.entries(details).map(([k, v]) => ({
            type: "mrkdwn",
            text: `*${k}:*\n\`${typeof v === "object" ? JSON.stringify(v) : v}\``,
          })),
        },
      ],
    };

    try {
      await axios.post(this.enterpriseSlackWebhook, payload, { timeout: 5000 });
      console.log(`[SLACK] Dispatched alert: "${title}"`);
    } catch (err: any) {
      console.error(`[ERROR] Failed to forward Slack webhook: ${err.message}`);
    }
  }

  public async sendFinancialReceiptEmail(subject: string, htmlContent: string): Promise<void> {
    if (!this.resendApiKey) {
      console.warn("[ALERT] Resend API key not configured, skipping email dispatch.");
      return;
    }

    const payload: ResendPayload = {
      from: "Kopernik Treasury <settlements@notify.kopernik.io>",
      to: [this.recipientAuditEmail],
      subject,
      html: htmlContent,
    };

    try {
      const response = await axios.post("https://api.resend.com/emails", payload, {
        headers: {
          Authorization: `Bearer ${this.resendApiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 8000,
      });
      console.log(`[RESEND] Receipt email sent successfully. Resend ID: ${response.data.id}`);
    } catch (err: any) {
      console.error(`[ERROR] Failed to dispatch via Resend: ${err.response?.data || err.message}`);
    }
  }

  public startEventListener(): void {
    console.log("[LISTENER] Subscribing to on-chain program log emission filter...");

    this.connection.onLogs(
      this.programId,
      async ({ logs, err, signature }) => {
        if (err) return;

        for (const log of logs) {
          if (log.includes("MilestoneApproved")) {
            await this.handleMilestoneApprovedEvent(signature, log);
          } else if (log.includes("DisputeOpened")) {
            await this.handleDisputeOpenedEvent(signature, log);
          } else if (log.includes("AgreementInitialized")) {
            await this.handleAgreementCreatedEvent(signature, log);
          }
        }
      },
      "confirmed"
    );

    console.log("[RUNNING] Sentinel operational. Listening for deterministic settlement triggers...");
  }

  private async handleMilestoneApprovedEvent(signature: string, log: string): Promise<void> {
    console.log(`[EVENT] MilestoneApproved confirmed in tx: ${signature}`);

    await this.notifySlack("Milestone Payout Disbursed", {
      Signature: signature,
      Explorer: `https://solscan.io/tx/${signature}?cluster=devnet`,
      Status: "COMPLETED",
      Timestamp: new Date().toISOString(),
    });

    const emailHtml = `
      <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e0e0e0; border-radius: 8px;">
        <h2 style="color: #059669;">Kopernik Settlement Confirmation</h2>
        <p>A milestone escrow has been approved by the client and funds have been unlocked from the PDA vault.</p>
        <ul>
          <li><strong>Transaction Signature:</strong> <code>${signature}</code></li>
          <li><strong>Network:</strong> Solana Devnet</li>
          <li><strong>Explorer Link:</strong> <a href="https://solscan.io/tx/${signature}?cluster=devnet">View on Solscan</a></li>
        </ul>
        <p style="color: #6b7280; font-size: 12px;">Automated cryptographic confirmation issued by Kopernik Sentinel.</p>
      </div>
    `;

    await this.sendFinancialReceiptEmail(
      `[Settled] Enterprise Milestone Payout Confirmed (${signature.slice(0, 8)})`,
      emailHtml
    );
  }

  private async handleDisputeOpenedEvent(signature: string, log: string): Promise<void> {
    console.log(`[ALERT] Escrow dispute flagged in tx: ${signature}`);

    await this.notifySlack("CRITICAL: Escrow Agreement Disputed", {
      Signature: signature,
      Explorer: `https://solscan.io/tx/${signature}?cluster=devnet`,
      Severity: "HIGH",
      RequiresAction: "Certified Arbiter Review",
    });
  }

  private async handleAgreementCreatedEvent(signature: string, log: string): Promise<void> {
    console.log(`[EVENT] New agreement initialized in tx: ${signature}`);

    await this.notifySlack("New Escrow Vault Funded", {
      Signature: signature,
      Explorer: `https://solscan.io/tx/${signature}?cluster=devnet`,
      Status: "ACTIVE",
    });
  }
}

// Entrypoint bootstrap
if (require.main === module) {
  const sentinel = new EnterpriseSentinel();
  sentinel.startEventListener();
}