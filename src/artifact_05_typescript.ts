import { Connection, PublicKey } from '@solana/web3.js';
import * as dotenv from 'dotenv';
import axios from 'axios';
import { Resend } from 'resend';

dotenv.config();

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const SOLANA_WSS_URL = process.env.SOLANA_WSS_URL || 'wss://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey(
  process.env.AMBERGUARD_PROGRAM_ID || 'AmbGuard111111111111111111111111111111111111'
);
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || 'accounting@enterprise.org';

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;

// Enterprise Deduplication Set
const processedSignatures = new Set<string>();

interface EscrowTelemetryEvent {
  eventType: 'FUNDED' | 'SUBMITTED' | 'APPROVED' | 'DISPUTED' | 'TIMEOUT_CLAIMED' | 'RESOLVED';
  signature: string;
  slot: number;
  escrowPubkey: string;
  details: Record<string, any>;
  timestamp: string;
}

class EnterpriseTelemetryHub {
  private connection: Connection;

  constructor() {
    this.connection = new Connection(SOLANA_RPC_URL, {
      wsEndpoint: SOLANA_WSS_URL,
      commitment: 'confirmed',
    });
  }

  public async start(): Promise<void> {
    console.log(`[AmberGuard Engine] Initializing WebSocket subscription on ${PROGRAM_ID.toBase58()}...`);

    this.connection.onLogs(
      PROGRAM_ID,
      async (logs, context) => {
        try {
          if (processedSignatures.has(logs.signature)) {
            return;
          }
          processedSignatures.add(logs.signature);

          // Garbage collect signature set if too large
          if (processedSignatures.size > 10_000) {
            processedSignatures.clear();
          }

          await this.processLogEntry(logs.signature, logs.logs, context.slot);
        } catch (err) {
          console.error('[Telemetry Error] Failed to process log entry:', err);
        }
      },
      'confirmed'
    );

    console.log('[AmberGuard Engine] Daemon listening for enterprise Solana settlement events.');
  }

  private async processLogEntry(signature: string, logs: string[], slot: number): Promise<void> {
    for (const line of logs) {
      if (line.includes('EscrowFundedEvent')) {
        await this.handleDispatch({
          eventType: 'FUNDED',
          signature,
          slot,
          escrowPubkey: 'PDA_DERIVED',
          details: { note: 'Escrow vault fully funded and locked on-chain' },
          timestamp: new Date().toISOString(),
        });
      } else if (line.includes('MilestoneSubmittedEvent')) {
        await this.handleDispatch({
          eventType: 'SUBMITTED',
          signature,
          slot,
          escrowPubkey: 'PDA_DERIVED',
          details: { note: 'Contractor delivered milestone work with cryptographic digest' },
          timestamp: new Date().toISOString(),
        });
      } else if (line.includes('MilestoneApprovedEvent')) {
        await this.handleDispatch({
          eventType: 'APPROVED',
          signature,
          slot,
          escrowPubkey: 'PDA_DERIVED',
          details: { note: 'Client approved milestone; funds released instantly' },
          timestamp: new Date().toISOString(),
        });
      } else if (line.includes('DisputeRaisedEvent')) {
        await this.handleDispatch({
          eventType: 'DISPUTED',
          signature,
          slot,
          escrowPubkey: 'PDA_DERIVED',
          details: { note: 'Dispute opened! Challenge period paused. Awaiting arbiter resolution.' },
          timestamp: new Date().toISOString(),
        });
      }
    }
  }

  private async handleDispatch(payload: EscrowTelemetryEvent): Promise<void> {
    console.log(`[AmberGuard Telemetry] Event [${payload.eventType}] detected at slot ${payload.slot}`);

    // 1. Dispatch to Slack Webhook
    if (SLACK_WEBHOOK_URL) {
      await this.dispatchSlack(payload);
    }

    // 2. Dispatch to Resend Email Service
    if (resend && NOTIFICATION_EMAIL) {
      await this.dispatchEmail(payload);
    }
  }

  private async dispatchSlack(payload: EscrowTelemetryEvent): Promise<void> {
    const colorMap = {
      FUNDED: '#36a64f',
      SUBMITTED: '#2196F3',
      APPROVED: '#00E676',
      DISPUTED: '#FF1744',
      TIMEOUT_CLAIMED: '#FF9100',
      RESOLVED: '#7C4DFF',
    };

    const slackPayload = {
      attachments: [
        {
          color: colorMap[payload.eventType] || '#cccccc',
          title: `Solana Settlement Alert: ${payload.eventType}`,
          title_link: `https://explorer.solana.com/tx/${payload.signature}?cluster=devnet`,
          fields: [
            { title: 'Status', value: payload.eventType, short: true },
            { title: 'Slot', value: payload.slot.toString(), short: true },
            { title: 'Transaction Signature', value: `\`${payload.signature}\``, short: false },
            { title: 'Details', value: JSON.stringify(payload.details), short: false },
          ],
          footer: 'AmberGuard Superteam Settlement Fabric',
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    };

    try {
      await axios.post(SLACK_WEBHOOK_URL, slackPayload);
      console.log('[Slack Notification] Dispatched successfully.');
    } catch (err: any) {
      console.error('[Slack Error] Could not post webhook:', err.message);
    }
  }

  private async dispatchEmail(payload: EscrowTelemetryEvent): Promise<void> {
    if (!resend) return;
    try {
      await resend.emails.send({
        from: 'AmberGuard Telemetry <onboarding@resend.dev>',
        to: [NOTIFICATION_EMAIL],
        subject: `[Settlement Notice] AmberGuard Event: ${payload.eventType}`,
        html: `
          <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #111;">
            <h2>AmberGuard Settlement Event Alert</h2>
            <p><strong>Action Type:</strong> ${payload.eventType}</p>
            <p><strong>Solana Slot:</strong> ${payload.slot}</p>
            <p><strong>Timestamp:</strong> ${payload.timestamp}</p>
            <hr />
            <p><strong>Explorer Verification:</strong></p>
            <p><a href="https://explorer.solana.com/tx/${payload.signature}?cluster=devnet">${payload.signature}</a></p>
            <hr />
            <p style="font-size: 12px; color: #888;">Automated enterprise event delivered by AmberGuard on Solana.</p>
          </div>
        `,
      });
      console.log('[Resend Email] Transactional notice sent to:', NOTIFICATION_EMAIL);
    } catch (err: any) {
      console.error('[Resend Error] Failed to send email:', err.message);
    }
  }
}

// Bootstrap service worker
const hub = new EnterpriseTelemetryHub();
hub.start().catch((err) => {
  console.error('[Fatal Error in Telemetry Service]:', err);
  process.exit(1);
});