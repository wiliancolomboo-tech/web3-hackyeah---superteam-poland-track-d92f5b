cp .env.example .env
# Edit .env with your RESEND_API_KEY and SLACK_WEBHOOK_URL

docker compose up -d --build
docker compose logs -f kreska-daemon