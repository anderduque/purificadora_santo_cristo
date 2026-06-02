# Deploy en Vercel

Este proyecto tiene un pipeline de GitHub Actions en `.github/workflows/vercel.yml`.

## Secrets necesarios en GitHub

Configura estos secrets en el repositorio:

- `VERCEL_TOKEN`
- `VERCEL_ORG_ID`
- `VERCEL_PROJECT_ID`

## Variables necesarias en Vercel

Configura estas variables en el proyecto de Vercel:

- `ADMIN_USER=admin`
- `ADMIN_PASSWORD=1234`
- `ADMIN_SESSION_SECRET=<un secreto largo y privado>`
- `STORAGE_BUCKET=purificadorasantocristo.firebasestorage.app`
- `STORAGE_SERVICE_ACCOUNT_JSON=<service account JSON completo o en base64>`
- `STORAGE_PUBLIC_UPLOADS=true` (pon `false` para usar URLs firmadas privadas)

No subas el JSON de la cuenta de servicio al repositorio.
