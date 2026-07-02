use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

use crate::paths::Paths;

#[cfg(unix)]
use std::{
    io::{BufRead, BufReader, Write},
    os::unix::{fs::FileTypeExt, net::UnixStream},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Command {
    Status,
    Doctor,
    Prune,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
/// One newline-delimited command on the daemon's control socket.
///
/// The version and snake-case command spelling are the wire contract consumed
/// by operator tooling.
///
/// ```
/// use persistence::control::{Command, Request};
///
/// let request = Request {
///     version: 1,
///     command: Command::Prune,
/// };
///
/// assert_eq!(
///     serde_json::to_string(&request).unwrap(),
///     r#"{"version":1,"command":"prune"}"#
/// );
/// ```
pub struct Request {
    pub version: u8,
    pub command: Command,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response {
    pub version: u8,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl Response {
    pub fn ok<T: Serialize>(payload: &T) -> Result<Self> {
        Ok(Self {
            version: 1,
            ok: true,
            payload: Some(serde_json::to_value(payload).context("encode response payload")?),
            error: None,
        })
    }

    pub fn error(error: impl ToString) -> Self {
        Self {
            version: 1,
            ok: false,
            payload: None,
            error: Some(error.to_string()),
        }
    }

    pub fn decode_payload<T: DeserializeOwned>(self) -> Result<T> {
        if !self.ok {
            bail!(
                "{}",
                self.error.unwrap_or_else(|| "daemon command failed".into())
            );
        }
        let payload = self.payload.context("daemon response missing payload")?;
        serde_json::from_value(payload).context("decode daemon response payload")
    }
}

pub fn request<T: DeserializeOwned>(socket: &Path, command: Command) -> Result<T> {
    #[cfg(not(unix))]
    {
        let _ = (socket, command);
        bail!("persistence control socket is only supported on Unix");
    }

    #[cfg(unix)]
    {
        request_with_timeout(socket, command, Duration::from_secs(10))
    }
}

pub fn query<T: DeserializeOwned>(paths: &Paths, command: Command) -> Result<T> {
    if !control_socket_available(paths) {
        bail!(
            "daemon is not running; expected control socket at {}",
            paths.control_socket.display()
        );
    }
    request(&paths.control_socket, command)
}

fn control_socket_available(paths: &Paths) -> bool {
    #[cfg(unix)]
    {
        std::fs::symlink_metadata(&paths.control_socket)
            .is_ok_and(|metadata| metadata.file_type().is_socket())
    }

    #[cfg(not(unix))]
    {
        let _ = paths;
        false
    }
}

#[cfg(unix)]
fn request_with_timeout<T: DeserializeOwned>(
    socket: &Path,
    command: Command,
    timeout: Duration,
) -> Result<T> {
    let mut stream =
        UnixStream::connect(socket).with_context(|| format!("connect {}", socket.display()))?;
    stream
        .set_read_timeout(Some(timeout))
        .context("set daemon read timeout")?;
    stream
        .set_write_timeout(Some(timeout))
        .context("set daemon write timeout")?;
    let request = Request {
        version: 1,
        command,
    };
    serde_json::to_writer(&mut stream, &request).context("encode daemon request")?;
    stream.write_all(b"\n").context("finish daemon request")?;
    stream.flush().context("flush daemon request")?;

    let mut line = String::new();
    BufReader::new(stream)
        .read_line(&mut line)
        .context("read daemon response")?;
    if line.is_empty() {
        bail!("daemon closed the control socket without a response");
    }

    let response: Response = serde_json::from_str(&line).context("decode daemon response")?;
    response.decode_payload()
}

#[cfg(test)]
mod tests {
    use super::{Command, Response};
    use crate::paths::Paths;
    use std::fs;

    #[test]
    fn response_decodes_typed_payload() {
        let response = Response::ok(&serde_json::json!({"ready": true})).unwrap();

        let payload: serde_json::Value = response.decode_payload().unwrap();

        assert_eq!(payload["ready"], true);
    }

    #[test]
    fn query_fails_when_daemon_is_not_running() {
        let fixture = Fixture::new();
        for command in [Command::Status, Command::Doctor, Command::Prune] {
            let error = super::query::<serde_json::Value>(&fixture.paths, command)
                .unwrap_err()
                .to_string();
            assert!(
                error.contains("daemon is not running"),
                "{command:?}: {error}"
            );
        }
    }

    #[test]
    fn query_rejects_stale_non_socket_control_path() {
        let fixture = Fixture::new();
        fs::create_dir_all(&fixture.paths.internal_dir).unwrap();
        fs::write(&fixture.paths.control_socket, "not a socket").unwrap();

        let error = super::query::<serde_json::Value>(&fixture.paths, Command::Status)
            .unwrap_err()
            .to_string();

        assert!(error.contains("daemon is not running"));
    }

    // A real listener at the control socket path is "daemon running": the
    // availability probe must answer true and the query must reach the socket.
    #[test]
    fn a_listening_socket_is_available_and_answers_queries() {
        use std::os::unix::net::{UnixListener, UnixStream};
        use std::thread;

        let fixture = Fixture::new();
        fs::create_dir_all(&fixture.paths.internal_dir).unwrap();
        let listener = UnixListener::bind(&fixture.paths.control_socket).unwrap();
        assert!(super::control_socket_available(&fixture.paths));

        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            use std::io::{BufRead, BufReader, Write};
            let mut line = String::new();
            BufReader::new(stream.try_clone().unwrap())
                .read_line(&mut line)
                .unwrap();
            let response = super::Response::ok(&serde_json::json!({"ready": true})).unwrap();
            serde_json::to_writer(&mut stream, &response).unwrap();
            stream.write_all(b"\n").unwrap();
        });

        let payload: serde_json::Value =
            super::query(&fixture.paths, Command::Status).unwrap();
        handle.join().unwrap();
        assert_eq!(payload["ready"], true);
    }

    struct Fixture {
        _temp: tempfile::TempDir,
        paths: Paths,
    }

    impl Fixture {
        fn new() -> Self {
            let temp = tempfile::tempdir().unwrap();
            let paths = Paths::new(
                temp.path().join("opt/persistence"),
                temp.path().join("run/persistence"),
                temp.path().join("data/persistence"),
            );
            Self { _temp: temp, paths }
        }
    }
}
