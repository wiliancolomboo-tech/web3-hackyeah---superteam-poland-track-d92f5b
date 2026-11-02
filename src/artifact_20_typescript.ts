import { Resend } from 'resend';

export class EmailService {
  private resend: Resend;
  private senderEmail: string;

  constructor(apiKey: string, senderEmail: string) {
    this.resend = new Resend(apiKey);
    this.senderEmail = senderEmail;
  }

  public async sendEscrowNotification(
    recipient: string,
    subject: string,
    escrowId: string,
    status: string,
    details: string
  ): Promise<void> {
    const htmlBody = `
      <div style="font-family: Arial, sans-serif; background-color: #0b0f19; color: #ffffff; padding: 24px; border-radius: 8px;">
        <h2 style="color: #14F195; border-bottom: 2px solid #9945FF; padding-bottom: 8px;">
          Project Boreas &bull; Escrow Event Notification
        </h2>
        <p>A deterministic milestone status update occurred on Solana Mainnet/Devnet.</p>
        <table style="width: 100%; border-collapse: collapse; margin-top: 16px; color: #e2e8f0;">
          <tr>
            <td style="padding: 8px; border: 1px solid #334155; font-weight: bold;">Escrow Reference ID</td>
            <td style="padding: 8px; border: 1px solid #334155; font-family: monospace;">${escrowId}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #334155; font-weight: bold;">Lifecycle State</td>
            <td style="padding: 8px; border: 1px solid #334155; font-family: monospace; color: #14F195;">${status}</td>
          </tr>
          <tr>
            <td style="padding: 8px; border: 1px solid #334155; font-weight: bold;">Details</td>
            <td style="padding: 8px; border: 1px solid #334155;">${details}</td>
          </tr>
        </table>
        <p style="margin-top: 24px; font-size: 12px; color: #94a3b8;">
          Superteam Poland &bull; Enterprise Solana Escrow Engine &bull; Non-Custodial & Verified
        </p>
      </div>
    `;

    try {
      const response = await this.resend.emails.send({
        from: this.senderEmail,
        to: recipient,
        subject: `[Boreas Escrow] ${subject} - Escrow #${escrowId}`,
        html: htmlBody,
      });
      console.log(`[EmailService] Resend email successfully dispatched: ${response.data?.id}`);
    } catch (error) {
      console.error('[EmailService] Failed to send email via Resend:', error);
    }
  }
}