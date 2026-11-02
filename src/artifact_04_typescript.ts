import { Connection, PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, Idl, EventParser, BorshEventCoder } from "@coral-xyz/anchor";
import { Resend } from "resend";
import axios from "axios";
import * as http from "http";

interface EnvironmentConfig {
  solanaRpcUrl: string;
  solanaWsUrl: string;
  programId: string;
  resendApiKey: string;
  slackWebhookUrl: string;
  notificationEmail: string;
  port: number;
}

const config: EnvironmentConfig = {
  solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com",
  solanaWsUrl: process.env.SOLANA_WS_URL || "wss://api.devnet.solana.com",
  programId: process.env.PROGRAM_ID || "SKrdYt8P6q7V3dZmWN9G9qBv5M8J2uV4pQ1X3Y7kE2r",
  resendApiKey: process.env.RESEND_API_KEY || "re_mock_test_key_enterprise",
  slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || "",
  notificationEmail: process.env.AUDIT_EMAIL || "cfo@superteam.pl",
  port: parseInt(process.env.PORT || "8080", 10),
};

const resend = new Resend(config.resendApiKey);

// Idempotent processed signatures cache
const processedSignatures = new Set<string>();

/**
 * Enterprise Audit Dispatcher via Resend
 */
async function sendEnterpriseEmail(subject: string, htmlContent: string): Promise<void> {
  if (!config.resendApiKey || config.resendApiKey.startsWith("re_mock")) {
    console.log(`[DRY-RUN RESEND] Subject: "${subject}" to: ${config.notificationEmail}`);
    return;
  }
  try {
    const response = await resend.emails.send({
      from: "SolKredyt Sentinel <sentinel@solkredyt.io>",
      to: [config.notificationEmail],
      subject,
      html: htmlContent,
    });
    console.log(`[RESEND SUCCESS] Sent Email ID: ${response.data?.id}`);
  } catch (error) {
    console.error("[RESEND ERROR] Failed to dispatch email:", error);
  }
}

/**
 * Enterprise SecOps Slack Dispatcher
 */
async function sendSlackNotification(title: string, fields: { title: string; value: string }[]): Promise<void> {
  if (!config.slackWebhookUrl) {
    console.log(`[DRY-RUN SLACK] Title: "${title}" - Fields: ${JSON.stringify(fields)}`);
    return;
  }
  try {
    await axios.post(config.slackWebhookUrl, {
      text: `*SolKredyt Protocol Alert: ${title}*`,
      attachments: [
        {
          color: "#14F195", // Solana green
          fields: fields.map((f) => ({ title: f.title, value: f.value, short: true })),
          footer: "SolKredyt Sentinel Daemon v1.0.0 (Superteam Poland)",
          ts: Math.floor(Date.now() / 1000),
        },
      ],
    });
    console.log(`[SLACK SUCCESS] Alert posted to ops channel: ${title}`);
  } catch (err: any) {
    console.error("[SLACK ERROR] Failed to push webhook:", err.message);
  }
}

/**
 * Event Processing Engine
 */
export async function runSentinelEngine(): Promise<void> {
  const connection = new Connection(config.solanaRpcUrl, {
    wsEndpoint: config.solanaWsUrl,
    commitment: "confirmed",
  });

  const programPubkey = new PublicKey(config.programId);
  console.log(`[STARTUP] SolKredyt Sentinel connected to Solana. Program ID: ${programPubkey.toBase58()}`);

  connection.onLogs(
    programPubkey,
    async (logsInfo, ctx) => {
      const signature = logsInfo.signature;
      if (processedSignatures.has(signature)) return;
      processedSignatures.add(signature);

      if (logsInfo.err) {
        console.warn(`[EVENT SKIPPED] Transaction ${signature} encountered an on-chain error.`);
        return;
      }

      console.log(`[NEW LOG DETECTED] Signature: ${signature} at slot: ${ctx.slot}`);

      for (const log of logsInfo.logs) {
        if (log.includes("InvoiceFundedEvent")) {
          await handleInvoiceFunded(signature, log);
        } else if (log.includes("FactorAdvanceEvent")) {
          await handleFactorAdvance(signature, log);
        } else if (log.includes("InvoiceDisputedEvent")) {
          await handleDisputeRaised(signature, log);
        } else if (log.includes("InvoiceSettledEvent")) {
          await handleInvoiceSettled(signature, log);
        }
      }
    },
    "confirmed"
  );
}

async function handleInvoiceFunded(signature: string, rawLog: string) {
  const emailHtml = `
    <h2>SolKredyt Enterprise Escrow Funded</h2>
    <p>An enterprise client has locked escrow capital into the SolKredyt settlement vault.</p>
    <ul>
      <li><strong>Transaction Signature:</strong> <code>${signature}</code></li>
      <li><strong>Network:</strong> Solana Devnet/Mainnet</li>
      <li><strong>Explorer URL:</strong> <a href="https://solscan.io/tx/${signature}">Inspect on Solscan</a></li>
    </ul>
    <p>Supplier milestone delivery is now authorized to commence.</p>
  `;
  await sendEnterpriseEmail("Invoice Escrow Funded - SolKredyt Audit", emailHtml);
  await sendSlackNotification("Invoice Escrow Funded", [
    { title: "Status", value: "Vault Locked (Funded)" },
    { title: "Tx Signature", value: signature.substring(0, 16) + "..." },
  ]);
}

async function handleFactorAdvance(signature: string, rawLog: string) {
  await sendSlackNotification("Instant Factor Underwriting Liquidity Injected", [
    { title: "Event", value: "Factor Advance Liquidity Paid" },
    { title: "Signature", value: signature.substring(0, 16) + "..." },
  ]);
}

async function handleDisputeRaised(signature: string, rawLog: string) {
  const alertSubject = "CRITICAL: Invoice Dispute Raised - SolKredyt Arbitration Required";
  const alertBody = `
    <h2 style="color: #ff3333;">Arbitration Required: Invoice Dispute Triggered</h2>
    <p>An invoice contract has entered the <strong>DISPUTED</strong> state. Automatic payouts have been halted.</p>
    <p><strong>Transaction:</strong> ${signature}</p>
    <p>Superteam Poland Arbitration Council credentials must be used to resolve this ticket.</p>
  `;
  await sendEnterpriseEmail(alertSubject, alertBody);
  await sendSlackNotification("CRITICAL: Invoice Dispute Raised", [
    { title: "Status", value: "HALTED - Dispute Initiated" },
    { title: "Action Required", value: "Arbitration Council Review" },
    { title: "Tx Signature", value: signature },
  ]);
}

async function handleInvoiceSettled(signature: string, rawLog: string) {
  await sendSlackNotification("Invoice Successfully Settled & Escrow Burned", [
    { title: "Status", value: "100% Finalized & Distributed" },
    { title: "Protocol Fee", value: "0.30% Collected to Treasury" },
    { title: "Tx Signature", value: signature },
  ]);
}

/**
 * Healthcheck & Telemetry HTTP Server
 */
const server = http.createServer((req, res) => {
  if (req.url === "/healthz" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "UP",
        service: "SolKredyt-Sentinel",
        version: "1.0.0",
        network: config.solanaRpcUrl,
        processedEventsCount: processedSignatures.size,
        timestamp: new Date().toISOString(),
      })
    );
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(config.port, () => {
  console.log(`[TELEMETRY] SolKredyt Sentinel healthz running on port ${config.port}`);
  runSentinelEngine().catch((err) => {
    console.error("[FATAL ERROR] Sentinel loop crashed:", err);
    process.exit(1);
  });
});