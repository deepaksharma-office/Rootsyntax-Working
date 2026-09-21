# Consultation lead backend

The theme section in `../sections/custom-consultation.liquid` posts to a Shopify app proxy. This folder contains the server handler. No backend or app is installed in the store yet, so the form's submit button is disabled until the app proxy is deployed and its storefront path is entered in the section settings.

## Connect the Shopify store

1. Create a Shopify app for the store with the `read_customers` and `write_customers` Admin API scopes. Obtain access to protected customer data as required by Shopify for customer email, phone, and name. Install the app and keep its Admin API token and app secret **only on the server**.
2. Configure an app proxy with storefront prefix `apps`, subpath `consultation-lead`, and proxy URL `https://YOUR-BACKEND.example/proxy/consultation-lead`. The store-facing path is `/apps/consultation-lead`. Set `APP_PROXY_BACKEND_PATH` if the backend URL uses a different path.
3. Deploy `server.mjs` to a Node.js 20+ HTTPS service. Route the app proxy to this service. Set its environment variables below. Ensure the service has a private, durable writable volume for `LEAD_STORAGE_DIR`; it stores each submission there separately, while customer metafields contain the latest lead values.
4. Add **Custom consultation** in the Shopify Theme Editor and enter `/apps/consultation-lead` in **Shopify app proxy path**. Test a real submission, then verify the customer, `lead` metafields, tags, and private submission record. The section can be added more than once.

The app proxy signs each request; the server checks the signature, timestamp, and shop before accepting it. Keep the server behind HTTPS. For more than one server instance, replace the included per-process IP limiter with shared rate limiting. Protect and back up the lead volume, set retention and deletion procedures, and restrict its access to staff who need it. Do not put this folder or its lead files in Shopify theme assets.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `SHOPIFY_APP_SECRET` | Shopify app secret used to verify proxy signatures. |
| `SHOPIFY_SHOP_DOMAIN` | Exact `example.myshopify.com` domain. |
| `SHOPIFY_ADMIN_TOKEN` | Server-only Admin API access token. |
| `LEAD_STORAGE_DIR` | Absolute path on a private, durable server volume. |
| `PORT` | Listening port; default `3000`. |
| `APP_PROXY_BACKEND_PATH` | Backend proxy path; default `/proxy/consultation-lead`. |
| `SHOPIFY_API_VERSION` | Admin GraphQL version; default `2026-07`. |
| `ALLOWED_SERVICES` | Pipe-separated allowed dropdown values. Keep synchronized with the section's service options. |
| `REQUIRE_NAME`, `REQUIRE_PHONE`, `REQUIRE_SERVICE` | Set any to `false` only if the corresponding field is optional or hidden in the section. Email always remains required for customer lookup. |
| `NOTIFICATION_WEBHOOK_URL`, `NOTIFICATION_WEBHOOK_TOKEN`, `NOTIFICATION_EMAIL` | Optional private notification service URL, bearer token, and authorized recipient. All three are required for notification delivery. The webhook must actually send the email. |

Set secrets through your hosting platform's secret manager. The theme never receives them. Run locally with `node consultation-backend/server.mjs` after setting the required variables. Run the backend tests with `node --test consultation-backend/server.test.mjs`.

The backend creates missing `lead` customer metafield definitions during its first successful request. For an existing customer it adds lead tags and sets lead metafields without changing their contact details or marketing subscription. Every submission is separately recorded in `LEAD_STORAGE_DIR`; a later submission updates the customer's latest lead metafields without deleting earlier records. The optional notification is sent only if the section asks for it and the recipient exactly matches `NOTIFICATION_EMAIL`.

Page URL, referrer, and UTM values are sent only when enabled in the section and Shopify's Customer Privacy API says analytics processing is allowed. The server creates the submission timestamp; it does not trust a browser timestamp. The message and other inputs are stored as text and must also be escaped by any later notification or admin UI that renders HTML.

Shopify references: [app proxies](https://shopify.dev/docs/apps/build/online-store/app-proxies), [proxy authentication](https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies), [customerCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/customerCreate), [Customer Privacy API](https://shopify.dev/docs/api/customer-privacy).
