import fetch from "node-fetch";

export interface EventNotificationPayload {
  title: string;
  invoiceId: string;
  pda: string;
  amountSol: number;
  recipientEmail?: string;
  details: string;
}

export class EnterpriseNotifier {
  private resendApiKey: string;
  private slackWebhookUrl: string;

  constructor() {
    this.resendApiKey = process.env.RESEND_API_KEY || "";
    this.slackWebhookUrl = process.env.SLACK_WEBHOOK_URL || "";

    if (!this.resendApiKey) {
      console.warn("[WARN] RESEND_API_KEY not configured. Email dispatch will be simulated.");
    }
    if (!this.slackWebhookUrl) {
      console.warn("[WARN] SLACK_WEBHOOK_URL not configured. Slack alert will be simulated.");
    }
  }

  public async notifyAll(payload: EventNotificationPayload): Promise<void> {
    await Promise.all([
      this.sendSlackWebhook(payload),
      this.sendResendEmail(payload),
    ]);
  }

  public async sendSlackWebhook(payload: EventNotificationPayload): Promise<void> {
    if (!this.slackWebhookUrl) {
      console.log(`[SLACK SIMULATION] ${payload.title} | Invoice: ${payload.invoiceId} | Amount: ${payload.amountSol} SOL`);
      return;
    }

    const body = {
      text: `*AURA Invoice Factoring Protocol Alert*\n*Event:* ${payload.title}\n*Invoice ID:* \`${payload.invoiceId}\`\n*Amount:* \`${payload.amountSol} SOL\`\n*PDA Vault:* \`${payload.pda}\`\n*Details:* ${payload.details}`,
    };

    try {
      const res = await fetch(this.slackWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        console.error(`[SLACK ERROR] Status: ${res.status}`);
      } else {
        console.log(`[SLACK DISPATCHED] Event: ${payload.title}`);
      }
    } catch (err) {
      console.error("[SLACK EXCEPTION]", err);
    }
  }

  public async sendResendEmail(payload: EventNotificationPayload): Promise<void> {
    const targetEmail = payload.recipientEmail || process.env.TREASURY_EMAIL || "cfo@enterprise-client.pl";

    if (!this.resendApiKey) {
      console.log(`[RESEND SIMULATION] To: ${targetEmail} | Subject: AURA: ${payload.title}`);
      return;
    }

    const emailBody = {
      from: "AURA Protocol Alerts <alerts@resend.dev>",
      to: [targetEmail],
      subject: `[AURA PROTOCOL] ${payload.title}: Invoice #${payload.invoiceId}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
          <h2 style="color: #111827;">AURA Invoice Notification</h2>
          <hr style="border: 0; border-top: 1px solid #eee;" />
          <p><strong>Status:</strong> ${payload.title}</p>
          <p><strong>Invoice ID:</strong> <code>${payload.invoiceId}</code></p>
          <p><strong>Settlement Amount:</strong> ${payload.amountSol} SOL</p>
          <p><strong>Solana PDA Address:</strong> <code>${payload.pda}</code></p>
          <p style="background: #f9fafb; padding: 12px; border-radius: 4px;">${payload.details}</p>
          <p style="font-size: 12px; color: #6b7280; margin-top: 24px;">
            AURA Protocol - Solana Enterprise Factoring Engine • KSeF Compliant
          </p>
        </div>
      `,
    };

    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(emailBody),
      });

      if (!res.ok) {
        const errorText = await res.text();
        console.error(`[RESEND ERROR] Status: ${res.status} Body: ${errorText}`);
      } else {
        console.log(`[RESEND DISPATCHED] Email confirmed to: ${targetEmail}`);
      }
    } catch (err) {
      console.error("[RESEND EXCEPTION]", err);
    }
  }
}