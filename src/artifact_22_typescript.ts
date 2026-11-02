import { Connection, PublicKey } from '@solana/web3.js';
import * as dotenv from 'dotenv';
import * as http from 'http';
import { EmailService } from './services/emailService';
import { WebhookService } from './services/webhookService';

dotenv.config();

const RPC_URL = process.env.SOLANA_RPC_URL || 'https://api.devnet.solana.com';
const WS_URL = process.env.SOLANA_WS_URL || 'wss://api.devnet.solana.com';
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || 'Boreas1111111111111111111111111111111111111'
);
const RESEND_API_KEY = process.env.RESEND_API_KEY || 're_dummy_test';
const SENDER_EMAIL = process.env.RESEND_SENDER_EMAIL || 'notifier@boreas.finance';
const RECIPIENT_EMAIL = process.env.ENTERPRISE_ALERT_EMAIL || 'treasury@superteam.poland';
const DISCORD_WEBHOOK = process.env.OPS_DISCORD_WEBHOOK_URL || '';
const PORT = parseInt(process.env.PORT || '8080', 10);

const emailService = new EmailService(RESEND_API_KEY, SENDER_EMAIL);
const webhookService = new WebhookService(DISCORD_WEBHOOK);

async function main() {
  console.log('='.repeat(60));
  console.log('🚀 Initializing Project Boreas Enterprise Notifier Daemon');
  console.log(`📡 Solana RPC: ${RPC_URL}`);
  console.log(`🔑 Escrow Program Target: ${PROGRAM_ID.toBase58()}`);
  console.log('='.repeat(60));

  const connection = new Connection(RPC_URL, {
    wsEndpoint: WS_URL,
    commitment: 'confirmed',
  });

  // Listen to program logs
  connection.onLogs(
    PROGRAM_ID,
    async (logs, ctx) => {
      if (logs.err) return;

      for (const log of logs.logs) {
        if (log.includes('EscrowInitializedEvent')) {
          console.log('[Event] Escrow Initialized detected!');
          await webhookService.broadcastEvent({
            eventName: 'Escrow Initialized',
            escrowId: 'DEVNET-ESCROW',
            timestamp: Math.floor(Date.now() / 1000),
          });
          await emailService.sendEscrowNotification(
            RECIPIENT_EMAIL,
            'New Escrow Initiated',
            'DEVNET-ESCROW',
            'Initialized',
            'Milestone escrow was successfully funded on-chain.'
          );
        } else if (log.includes('EscrowCompletedEvent')) {
          console.log('[Event] Escrow Completed detected!');
          await webhookService.broadcastEvent({
            eventName: 'Escrow Completed & Settled',
            escrowId: 'DEVNET-ESCROW',
            timestamp: Math.floor(Date.now() / 1000),
          });
          await emailService.sendEscrowNotification(
            RECIPIENT_EMAIL,
            'Settlement Dispatched',
            'DEVNET-ESCROW',
            'Completed',
            'Contractor funds unlocked and disbursed unconditionally.'
          );
        }
      }
    },
    'confirmed'
  );

  // Lightweight healthcheck server for Docker and Cloud run probes
  const server = http.createServer((req, res) => {
    if (req.url === '/health' || req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'HEALTHY', timestamp: new Date().toISOString() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(PORT, () => {
    console.log(`[HealthCheck] Healthcheck endpoint running on http://0.0.0.0:${PORT}/health`);
  });
}

main().catch((err) => {
  console.error('[Fatal Engine Failure]', err);
  process.exit(1);
});