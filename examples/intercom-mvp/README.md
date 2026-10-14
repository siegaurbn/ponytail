# Universal intercom MVP

A standalone example built with Ponytail. The parent repository is an agent skill, not an existing mobile application; its plugin, prompts, release scripts, and benchmark examples stay intact. This example is excluded from the npm plugin package.

## What runs

- Node 22+ API and an independently runnable LAN edge agent; no npm dependencies.
- Authenticated resident door list, HTTP-first unlock, idempotency, audit events, call ownership, device registration, APNs VoIP and FCM HTTP v1 senders.
- AKUVOX, DNAKE legacy/webapi, BAS-IP HTTP profiles with credentials confined to the edge.
- Android app: WebView, JNI/libbaresip, G.711, RTP-event or SIP INFO DTMF, FCM data pushes, self-managed Telecom calls, ongoing call service/notification.
- iOS app sources: WKWebView, the same C/libbaresip bridge, PushKit registration, immediate CallKit reporting, answer/end handling and microphone permission.
- Authenticated WHEP proxy/player and a MediaMTX configuration for RTSP input; the client never receives camera credentials.
- Separate personal-account WebView, without the intercom native bridge.

This is a lab MVP. There are no fabricated SIP/audio successes: answering requires a real SIP INVITE with the exact `sipCallId`, and DTMF requires an established libbaresip call. The desktop demo explicitly simulates panel HTTP responses; it does not simulate working voice, push delivery or a camera.

## Try the desktop demo

From `examples/intercom-mvp`:

```sh
npm start
# Open http://127.0.0.1:8090
# Enter: demo-resident-token-change-me
```

In another terminal:

```sh
node scripts/ring.js entrance
npm test
```

The entrance and lobby accept simulated HTTP unlocks. The gate demonstrates a commissioned `httpEnabled:false` profile: unlock cannot succeed without a real established SIP call for its DTMF fallback. The browser shows incoming calls but has no SIP engine; use the mobile shell for voice. The personal-account URL is a placeholder. Video needs a separately configured MediaMTX and camera.

## Architecture and boundaries

```text
Android / iOS
  native PushKit/CallKit or FCM/Telecom + libbaresip (SIP/RTP voice)
  WebView: resident UI + WHEP video | separate personal account
               HTTPS                      SIP/RTP
                 |                            |
       API (resident authorization)     SIP registrar/proxy/media relay
          |                 |                  |
    private edge RPC    WHEP proxy         panel SIP
          |                 |
    vendor HTTP        MediaMTX <--- private RTSP
          |                 |
     AKUVOX / DNAKE / BAS-IP on building LAN
```

The API accepts the logical door and request ID, never a client-supplied panel URL, relay, HTTP command or credential. The edge maps that door to a locally commissioned profile. API-to-edge is a small `/unlock` RPC; replace `edgeUnlock` with a VPN/reverse-tunnel transport without changing resident endpoints. Keep panel APIs, MediaMTX HTTP and edge RPC off the public Internet. Terminate resident HTTPS at your reverse proxy. Restrict camera/edge egress and validate TLS certificates when using HTTPS panel endpoints.

### API contract

All `/api/*` routes require `Authorization: Bearer <resident token>`; all `/internal/*` routes require the distinct internal SIP token. The example uses static per-resident tokens configured through environment variables; it does not implement billing-system login/OIDC.

| Method | Route | Purpose |
|---|---|---|
| GET | `/api/bootstrap` | Authorized doors and personal-account URL |
| POST / DELETE | `/api/devices` / `/api/devices/{deviceId}` | Register/rotate/remove the user's push token |
| GET | `/api/calls` / `/api/calls/{callId}` | Current calls / reconcile a push |
| POST | `/api/calls/{callId}/answer` | Claim the call with `{deviceId}` |
| POST | `/api/calls/{callId}/active` | Native libbaresip established callback |
| POST | `/api/calls/{callId}/end` | End the call |
| POST | `/api/doors/{doorId}/unlock` | `{requestId, callId?, deviceId?}` |
| POST / DELETE | `/api/doors/{doorId}/whep` / `/api/video/{sessionId}` | Authorized SDP exchange and cleanup |
| POST | `/internal/calls` | Trusted SIP ingress creates a call and sends pushes |
| POST | `/internal/calls/{callId}/end` | SIP CANCEL/BYE/timeout reconciliation |

Call transitions: `ringing → answering → active → ended`, or `expired`. One device claims the call. Ring lifetime is at most 90 seconds; active calls have a five-minute lab limit. Clients reconcile state every two seconds and stop calls that expired, ended, or were answered elsewhere. Native answer waits up to ten seconds for the matching SIP INVITE.

HTTP success means **the panel accepted the command**, not that a physical door sensor confirmed opening. DTMF response means **authorized to send digits**, not physically opened. Only a deliberately disabled HTTP profile yields `unavailable` and permits DTMF for that resident's active call/device. Authentication failure, timeout, unexpected response, 4xx/5xx and lost upstream responses never trigger automatic fallback. Repeating the same request ID reuses the original result for ten minutes. Reusing it with different data fails. Native DTMF rejects recent duplicate IDs and schedules digit press/release on the SIP event loop.

### SIP proxy / push integration

The registrar/proxy (for example OpenSIPS) remains an external service. This example supplies the ingress contract, not a ready production OpenSIPS routing configuration. Your SIP adapter must:

1. Authenticate the panel and derive resident/door from provisioned routing data.
2. Create one lowercase UUID `callId`, retain the **actual, case-sensitive SIP Call-ID** as `sipCallId`, and POST:

```json
{
  "callId": "731c3cb0-986e-4f53-b2ad-18a98c924b01",
  "sipCallId": "actual-invite-call-id@panel",
  "userId": "resident",
  "doorId": "entrance",
  "expiresAt": 1791979260000
}
```

3. Hold the pending INVITE, wake registered devices, wait for their SIP REGISTER and fork/route the same INVITE with the retained Call-ID. Do not wait until the SIP transaction has already expired to push.
4. POST `/internal/calls/{callId}/end` on CANCEL/BYE/final failure. Replaying ingress is deduplicated.

The sample timestamp above is illustrative; use `Date.now() + 60000`. Push contains only call identifiers, name, door and expiry, never SIP passwords or panel/camera secrets. APNs uses ES256 `.p8` authentication, `voip` push type and `<bundleId>.voip` topic. FCM uses OAuth service-account credentials and high-priority **data-only** messages with short TTL. Native PushKit reports to CallKit before any API wait, including stale/invalid pushes, then reconciles and ends invalid calls. No non-call updates are sent through VoIP push.

## Configure real services

Copy `config/api.example.json` and `config/edge.example.json` to the ignored `config/local-api.json` and `config/local-edge.json`. Store credentials in environment variables and push key files under the ignored `secrets/` directory. From the example directory, in separate terminals:

```sh
node --env-file=config/.env src/edge.js
node --env-file=config/.env src/api.js
```

Create `config/.env` from `.env.example`; use random, distinct tokens of at least 24 characters. The example config intentionally refuses real panel use until every enabled profile is marked `commissioned:true`. First verify relay numbering, authentication and observed success/failure responses on your exact model/firmware, then replace `successPattern` with a checked response pattern. Basic authentication support does not implement HTTP Digest challenge negotiation. BAS-IP needs a provisioned bearer token; token login/refresh is not automatic. Some DNAKE firmware uses a password-derived MD5 in its URL; treat it as a secret, use it only on a private LAN/VPN, and suppress URL logging in network infrastructure.

| Adapter/profile | Request template | Commissioning caveat |
|---|---|---|
| AKUVOX | `/fcgi/OpenDoor?action=OpenDoor&DoorNum={relay}` | HTTP access/High Security Mode/auth must match firmware |
| DNAKE `legacy` | `/cgi-bin/ext/control.cgi?op=unlock` | Single legacy unlock; no relay selection in this endpoint |
| DNAKE `webapi` | `/cgi-bin/webapi.cgi?api=unlock&index={relay}&username=…&password={MD5}` | Supported firmware only; response/auth vary |
| BAS-IP Android panels v1 | `/api/v1/access/general/lock/open/remote/accepted/{relay}` | Provision token and correct lock number |

MediaMTX: use the separately installed, MIT-licensed server with `config/mediamtx.yml`, replacing private RTSP URLs, read credentials and reachable ICE host. Set `MEDIA_AUTHORIZATION` to the corresponding Basic credential on the backend. WHEP HTTP stays reachable only by the backend; clients need access to MediaMTX's advertised ICE UDP endpoint. Use a TURN server when the network requires it. MediaMTX **does not transcode**: select a WebRTC-compatible camera video codec/profile (typically H.264 without B-frames). The video element is muted; call audio comes from SIP. The minimal player gathers ICE before POST and does not implement trickle ICE or consume WHEP ICE-server Link headers.

## Build mobile apps

### Android

JDK 17+, Android SDK 35, Android 9+ (API 28), NDK `28.2.13676358`, CMake `3.22.1`; Gradle wrapper is included. libbaresip/libre and Mbed TLS (crypto primitives only) are fetched at pinned revisions. No proprietary SIP SDK.

```sh
cd mobile/android
./gradlew assembleDebug lintDebug
```

On Windows use `gradlew.bat`; for long workspace paths pass `-PnativeBuildDir=C:/short/path` to keep Ninja paths under Windows limits. Configure Firebase via local Gradle properties `firebaseApiKey`, `firebaseApplicationId`, `firebaseProjectId`, `firebaseSenderId` from your Firebase Android app. With these absent, the UI/SIP app builds but FCM registration is disabled. Configure its matching service account on the backend; do not put that private key in the app.

Install the debug APK, allow microphone/notifications, enter the API URL and a provisioned libbaresip account string, then enter the resident token on the WebView. Emulator loopback is `http://10.0.2.2:8090`; cleartext resident HTTP is limited to emulator/localhost hosts. Devices use HTTPS. The account can include `;auth_user=…;auth_pass=…;regint=300;dtmfmode=rtpevent` or `dtmfmode=sipinfo` according to panel negotiation. Start with a laboratory SIP server reachable from device and panel; provide an RTP relay/NAT strategy outside this sample. Android credentials currently use app-private preferences with backup disabled; replace them with Keystore-backed storage before production.

### iOS

macOS/Xcode, CMake and XcodeGen are required. Example simulator build on Apple Silicon:

```sh
cd native
cmake -S . -B build-ios -DCMAKE_SYSTEM_NAME=iOS -DCMAKE_OSX_SYSROOT=iphonesimulator -DCMAKE_OSX_ARCHITECTURES=arm64 -DCMAKE_OSX_DEPLOYMENT_TARGET=16.0 -DCMAKE_BUILD_TYPE=Release
cmake --build build-ios --target intercom -j 3
cd ../mobile/ios
xcodegen generate
xcodebuild -project IntercomMvp.xcodeproj -scheme IntercomMvp -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' ARCHS=arm64 CODE_SIGNING_ALLOWED=NO build
```

For an Intel simulator replace arm64 with x86_64 in both commands. For a device use `iphoneos`, rebuild libraries for arm64, and select your signing team/bundle ID. Enable Push Notifications, supply APNs keys/topic on the backend, and align `aps-environment` with sandbox/production. A real device and signing are required to validate background PushKit delivery. Configure an HTTPS API; ATS stays enabled. SIP and API credentials use Keychain after-first-unlock storage. The personal account loads in a separate WKWebView; no privileged handler or resident token is forwarded to it. The shared UI requires a fresh token login after its WebView is recreated; native call handling uses the stored token. A small compatibility function reports unsupported client-certificate loading because libre 4.12 omits that TLS-stub symbol on Apple; remove it when upgrading to a backend that provides the symbol.

## Validation and limits

`npm test` in this directory covers resident authorization, concurrent unlock deduplication, exact vendor requests, uncertain-outcome handling, DTMF eligibility, call/device ownership, push replay/expiry, request limits and APNs signature format. The repository's normal `npm test` includes these tests. The `intercom` workflow builds native Android/APK and runs lint, and builds the iOS simulator shell without signing. Existing repository tests and rule/version checks are preserved.

Known limits to address before a provider pilot:

- Native SIP build currently uses **unencrypted SIP/RTP** and G.711; add verified TLS/SRTP, NAT/media relay and audio-route/echo handling for real networks. The Mbed TLS addition supplies hashing, not transport encryption.
- State, registered devices, audit sink and idempotency are in memory. Restart loses them, including relay deduplication; use durable transactional storage and a push outbox before connecting real relays. Do not run multiple API/edge instances with these stores.
- The API trusts an authenticated mobile client's `active` report; the native bridge additionally verifies libbaresip call state/Call-ID. A production SIP adapter should authoritatively confirm call ownership/establishment and end events.
- Push credentials/account provisioning, real vendor commissioning and physical-door confirmation are external. No claim of hardware compatibility across all firmware versions.
- CallKit audio activation, Telecom routing, app suspension/force-stop, Doze, duplicate/stale pushes, reconnect and competing devices need real-device verification. APNs/FCM delivery is not guaranteed. The example reconciles by polling and does not include a durable background reconnect service.
- Static resident credentials, Android secret storage, web/native origin hardening for your hosting/SSO setup, audit persistence, native DTMF deduplication across process restarts and platform entitlement review need completion before distribution.

## Software licenses and cost scope

The application/example is MIT. libbaresip and libre are BSD-3-Clause; selected G.711/platform audio modules ship with baresip. Mbed TLS is Apache-2.0 OR GPL-2.0-or-later; use its Apache-2.0 option and retain notices. MediaMTX is MIT; Firebase Android SDK components use Apache-2.0. Keep third-party notices with distributed binaries. Optional OpenSIPS is a separate GPL server, not linked into the mobile app. No SIP SDK per-seat/runtime licensing fee is introduced. Hosting, hardware, networking and Apple/Google developer/distribution accounts can still cost money; zero software license fees does not mean zero operating cost.

Primary references used for these integration profiles:

- [libbaresip public API](https://github.com/baresip/baresip/blob/v4.12.0/include/baresip.h), [library integration](https://github.com/baresip/baresip/wiki/Using-baresip-as-a-library), [baresip license](https://github.com/baresip/baresip/blob/v4.12.0/LICENSE).
- [AKUVOX HTTP unlock](https://knowledge.akuvox.com/docs/open-door-via-http-command).
- [DNAKE legacy HTTP unlock](https://www.dnake-global.com/faqs/ip-intercom/page/3/), [E214 webapi manual](https://www.dnake-global.com/uploads/DNAKE-Indoor-Monitor-E214-User-Manual_V1.0.pdf).
- [BAS-IP lock API](https://developers.bas-ip.com/android-panels/open-lock-via-http/).
- [MediaMTX configuration](https://mediamtx.org/docs/references/configuration-file), [browser/WHEP reader](https://mediamtx.org/docs/read/web-browsers).
- [Apple PushKit lifecycle](https://developer.apple.com/documentation/pushkit/responding-to-voip-notifications-from-pushkit), [FCM Android delivery](https://firebase.google.com/docs/cloud-messaging/android/receive-messages).
