//! tpu-send: a tiny sidecar for the experiment (stdin/stdout, one JSON object per line).
//!
//! Requests:
//!   {"op":"connect","addr":"ip:port"}
//!       open (or reuse) a QUIC connection to that TPU address; used a few seconds before the window
//!       so the handshake is not part of the measured send.
//!   {"op":"batch","addr":"ip:port","gap_ms":15,"txs":[{"id":"<sig>","tx":"<base64 wire tx>"}, ...]}
//!       send the transactions IN THE GIVEN ORDER, one unidirectional stream each (the Solana TPU
//!       protocol), with `gap_ms` between stream opens.
//! Responses: one line per request ("connect") or per transaction ("sent"), always with a
//! microsecond wall-clock timestamp taken right before the stream was opened.
//!
//! Like every Solana client, we present a throwaway self-signed ed25519 certificate (the server
//! reads its public key to look up stake: ours has none, so we get the unstaked QoS tier) and
//! do not verify the server certificate. ALPN is "solana-tpu".
use base64::Engine;
use quinn::{crypto::rustls::QuicClientConfig, ClientConfig, Connection, Endpoint, IdleTimeout, TransportConfig};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::{crypto::CryptoProvider, DigitallySignedStruct, SignatureScheme};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[derive(Debug)]
struct SkipServerVerification(Arc<CryptoProvider>);

impl ServerCertVerifier for SkipServerVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

fn client_config() -> Result<ClientConfig, Box<dyn std::error::Error>> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let key = rcgen::KeyPair::generate_for(&rcgen::PKCS_ED25519)?;
    let cert = rcgen::CertificateParams::new(vec!["solana".to_string()])?.self_signed(&key)?;
    let mut tls = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(SkipServerVerification(provider)))
        .with_client_auth_cert(
            vec![cert.der().clone()],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key.serialize_der())),
        )?;
    tls.alpn_protocols = vec![b"solana-tpu".to_vec()];
    let mut cfg = ClientConfig::new(Arc::new(QuicClientConfig::try_from(tls)?));
    let mut transport = TransportConfig::default();
    transport.max_idle_timeout(Some(IdleTimeout::try_from(Duration::from_secs(10))?));
    transport.keep_alive_interval(Some(Duration::from_secs(1)));
    cfg.transport_config(Arc::new(transport));
    Ok(cfg)
}

#[derive(Deserialize)]
struct TxIn {
    id: String,
    tx: String,
}

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Request {
    Connect { addr: String },
    Batch { addr: String, gap_ms: u64, txs: Vec<TxIn> },
}

fn now_us() -> u128 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_micros()
}

struct Sender {
    endpoint: Endpoint,
    conns: HashMap<SocketAddr, Connection>,
}

impl Sender {
    async fn conn(&mut self, addr: SocketAddr) -> Result<Connection, String> {
        if let Some(c) = self.conns.get(&addr) {
            if c.close_reason().is_none() {
                return Ok(c.clone());
            }
        }
        let connecting = self.endpoint.connect(addr, "solana").map_err(|e| e.to_string())?;
        let c = tokio::time::timeout(Duration::from_secs(3), connecting)
            .await
            .map_err(|_| "connect timeout".to_string())?
            .map_err(|e| e.to_string())?;
        self.conns.insert(addr, c.clone());
        Ok(c)
    }
}

async fn send_one(conn: &Connection, bytes: &[u8]) -> Result<(), String> {
    let mut s = conn.open_uni().await.map_err(|e| e.to_string())?;
    s.write_all(bytes).await.map_err(|e| e.to_string())?;
    s.finish().map_err(|e| e.to_string())?;
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut endpoint = Endpoint::client("0.0.0.0:0".parse()?)?;
    endpoint.set_default_client_config(client_config()?);
    let mut sender = Sender { endpoint, conns: HashMap::new() };
    let mut out = tokio::io::stdout();
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let b64 = base64::engine::general_purpose::STANDARD;

    while let Some(line) = lines.next_line().await? {
        let replies: Vec<serde_json::Value> = match serde_json::from_str::<Request>(&line) {
            Err(e) => vec![json!({"op":"error","err":e.to_string()})],
            Ok(Request::Connect { addr }) => {
                let t0 = Instant::now();
                match addr.parse::<SocketAddr>() {
                    Err(e) => vec![json!({"op":"connect","addr":addr,"ok":false,"err":e.to_string()})],
                    Ok(sa) => match sender.conn(sa).await {
                        Ok(c) => vec![json!({"op":"connect","addr":addr,"ok":true,"ms":t0.elapsed().as_millis(),"rtt_ms":c.rtt().as_millis()})],
                        Err(e) => vec![json!({"op":"connect","addr":addr,"ok":false,"err":e,"ms":t0.elapsed().as_millis()})],
                    },
                }
            }
            Ok(Request::Batch { addr, gap_ms, txs }) => {
                let mut r = Vec::with_capacity(txs.len());
                let conn = match addr.parse::<SocketAddr>() {
                    Err(e) => Err(e.to_string()),
                    Ok(sa) => sender.conn(sa).await,
                };
                // Streams are opened and written strictly one after another, in the given order. We do not
                // wait for any acknowledgement: write_all returns once the bytes are queued in quinn.
                for (i, t) in txs.iter().enumerate() {
                    if i > 0 && gap_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(gap_ms)).await;
                    }
                    let ts = now_us();
                    let res = match (&conn, b64.decode(&t.tx)) {
                        (Err(e), _) => Err(e.clone()),
                        (_, Err(e)) => Err(e.to_string()),
                        (Ok(c), Ok(bytes)) => send_one(c, &bytes).await,
                    };
                    r.push(json!({"op":"sent","id":t.id,"ok":res.is_ok(),"err":res.err(),"t_us":ts.to_string()}));
                }
                r
            }
        };
        for v in replies {
            out.write_all(format!("{v}\n").as_bytes()).await?;
        }
        out.flush().await?;
    }
    Ok(())
}
