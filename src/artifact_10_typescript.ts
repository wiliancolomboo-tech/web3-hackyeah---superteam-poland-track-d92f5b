import axios from "axios";

export class NotificationDispatcher {
  private resendApiKey: string;
  private slackWebhookUrl: string;
  private recipientEmail: string;

  constructor(resendApiKey: string, slackWebhookUrl: string, recipientEmail: string) {
    this.resendApiKey = resendApiKey;
    this.slackWebhookUrl = slackWebhookUrl;
    this.recipientEmail = recipientEmail;
  }

  public async sendSlackAlert(title: string, message: string, color: string = "#36a64f"): Promise<void> {
    if (!this.slackWebhookUrl) {
      console.warn("[WARN] Slack Webhook URL not configured. Skipping alert.");
      return;
    }

    try {
      await axios.post(this.slackWebhookUrl, {
        attachments: [
          {
            color: color,
            title: `[Vistula Escrow] ${title}`,
            text: message,
            footer: "Vistula Sentinel Automated Engine",
            ts: Math.floor(Date.now() / 1000),
          },
        ],
      });
      console.log(`[SLACK] Alert dispatched: ${title}`);
    } catch (err: any) {
      console.error("[ERROR] Failed to post to Slack:", err.message);
    }
  }

  public async sendEmailReceipt(subject: string, htmlContent: string): Promise<void> {
    if (!this.resendApiKey) {
      console.warn("[WARN] Resend API key not configured. Skipping email dispatch.");
      return;
    }

    try {
      const response = await axios.post(
        "https://api.resend.com/emails",
        {
          from: "settlement@vistula.finance",
          to: [this.recipientEmail],
          subject: `[Vistula Settlement] ${subject}`,
          html: htmlContent,
        },
        {
          headers: {
            Authorization: `Bearer ${this.resendApiKey}`,
            "Content-Type": "application/json",
          },
        }
      );
      console.log(`[RESEND] Invoice receipt sent! ID: ${response.data.id}`);
    } catch (err: any) {
      console.error("[ERROR] Failed to send email via Resend:", err.response?.data || err.message);
    }
  }
}