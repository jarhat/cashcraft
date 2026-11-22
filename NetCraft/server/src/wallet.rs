use std::fs::File;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

#[derive(Clone, Default)]
pub struct Session {
    challenge: Option<(Instant, String)>,
    last_request: Option<Instant>,
}

impl Session {
    pub fn revoke(&mut self) {
        self.challenge = None;
    }

    pub fn request(&mut self) -> Option<String> {
        let now = Instant::now();
        if self.last_request.is_some_and(|last| now.duration_since(last) < Duration::from_secs(3)) {
            return None;
        }
        self.last_request = Some(now);
        let mut bytes = [0; 32];
        File::open("/dev/urandom").ok()?.read_exact(&mut bytes).ok()?;
        let nonce: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
        self.challenge = Some((now, nonce.clone()));
        Some(nonce)
    }

    pub fn consume(&mut self) -> Option<String> {
        let (issued, nonce) = self.challenge.take()?;
        (issued.elapsed() < Duration::from_secs(120)).then_some(nonce)
    }
}

pub struct Verifier {
    pub target: String,
    pub secret: String,
}

#[derive(PartialEq, Eq, Debug)]
pub enum Proof {
    Rejected,
    Wallet,
}

impl Verifier {
    pub fn verify(&self, address: &str, nonce: &str, signature: &str) -> Proof {
        if signature.len() != 88 || !signature.ends_with('=')
            || !signature.as_bytes()[..87].iter().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/'))
        {
            return Proof::Rejected;
        }

        // These fields come from the validated W command, our nonce, and base64.
        let verify = || -> io::Result<Proof> {
            let remote = self.target.to_socket_addrs()?.next()
                .ok_or_else(|| io::Error::other("wallet verifier address did not resolve"))?;
            let mut stream = TcpStream::connect_timeout(&remote, Duration::from_secs(2))?;
            stream.set_read_timeout(Some(Duration::from_secs(5)))?;
            stream.set_write_timeout(Some(Duration::from_secs(2)))?;
            let body = format!(r#"{{"address":"{address}","nonce":"{nonce}","signature":"{signature}"}}"#);
            write!(stream, "POST /api/internal/netcraft-admin-proof HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                self.target, self.secret, body.len())?;
            let mut line = String::new();
            BufReader::new(stream.take(256)).read_line(&mut line)?;
            let proof = match line.split_ascii_whitespace().take(2).collect::<Vec<_>>().as_slice() {
                ["HTTP/1.1" | "HTTP/1.0", "204" | "202"] => Proof::Wallet,
                _ => Proof::Rejected,
            };
            Ok(proof)
        };
        verify().unwrap_or(Proof::Rejected)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proof_challenges_are_unique_one_use_and_expire() {
        let mut first = Session::default();
        let mut second = Session::default();
        let nonce = first.request().unwrap();
        assert_ne!(nonce, second.request().unwrap());
        assert_eq!(first.consume().unwrap(), nonce);
        assert!(first.consume().is_none());
        assert!(first.request().is_none());
        second.challenge.as_mut().unwrap().0 -= Duration::from_secs(121);
        assert!(second.consume().is_none());
    }
}
