import fetch from 'node-fetch';
import { EscrowEventPayload } from '../types';

export class WebhookService {
  private discordWebhookUrl: string;

  constructor(discordWebhookUrl: string) {
    this.discordWebhookUrl = discordWebhookUrl;
  }

  public async broadcastEvent(payload: EscrowEventPayload): Promise<void> {
    if (!this.discordWebhookUrl) {
      console.warn('[WebhookService] Discord Webhook URL not provided. Skipping broadcast.');
      return;
    }

    const embed = {
      title: `⚡ Solana Escrow Event: ${payload.eventName}`,
      color: payload.eventName.includes('Completed') ? 0x14f195 : 0x9945ff,
      fields: [
        { name: 'Escrow ID', value: `\`${payload.escrowId}\``, inline: true },
        { name: 'Timestamp', value: new Date(payload.timestamp * 1000).toISOString(), inline: true },
        { name: 'Client', value: payload.client ? `\`${payload.client}\`` : 'N/A', inline: false },
        { name: 'Contractor', value: payload.contractor ? `\`${payload.contractor}\`` : 'N/A', inline: false },
        { name: 'Locked Amount', value: payload.amount ? `${payload.amount} Units` : 'N/A', inline: true },
      ],
      footer: {
        text: 'Boreas Engine • Superteam Poland • HackYeah Track',
      },
    };

    try {
      const response = await fetch(this.discordWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embeds: [embed] }),
      });

      if (!response.ok) {
        throw new Error(`Discord Webhook returned status code ${response.status}`);
      }
      console.log(`[WebhookService] Ops webhook successfully fired for Escrow ${payload.escrowId}`);
    } catch (err) {
      console.error('[WebhookService] Failed to execute webhook alert:', err);
    }
  }
}