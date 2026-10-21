#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_canonical_spotify_uri_and_open_urls() {
        assert_eq!(
            parse_source("spotify:track:0123456789012345678901")
                .unwrap()
                .kind,
            Kind::Track
        );
        assert_eq!(
            parse_source("https://open.spotify.com/album/0123456789012345678901?si=x")
                .unwrap()
                .kind,
            Kind::Album
        );
        for input in [
            "spotify:artist:0123456789012345678901",
            "https://evil.example/track/0123456789012345678901",
            "https://open.spotify.com.evil.example/track/0123456789012345678901",
            "https://user@open.spotify.com/track/0123456789012345678901",
            "https://open.spotify.com:443/track/0123456789012345678901",
            "https://open.spotify.com/track/0123456789012345678901/extra",
            "https://open.spotify.com/track/0123456789012345678901#fragment",
            "spotify:track:012345678901234567890",
            "spotify:track:0123456789012345678901?x=y",
        ] {
            assert!(parse_source(input).is_err(), "accepted {input}");
        }
    }

    #[test]
    fn expansion_is_bounded_and_atomic() {
        let ids = vec!["track".to_string(); MAX_ITEMS];
        assert_eq!(
            validate_expansion(MAX_ITEMS, &ids, 0, false).unwrap().len(),
            MAX_ITEMS
        );
        assert!(validate_expansion(MAX_ITEMS + 1, &ids, 0, false).is_err());
        assert!(validate_expansion(2, &ids[..1], 0, false).is_err());
        assert!(validate_expansion(2, &["track".into(), "episode".into()], 0, false).is_err());
        assert!(validate_expansion(2, &ids[..2], 1, false).is_err());
        assert!(validate_expansion(2, &ids[..2], 0, true).is_err());
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Track,
    Album,
    Playlist,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Source {
    pub kind: Kind,
    pub id: String,
}

pub const MAX_ITEMS: usize = 500;

pub fn parse_source(input: &str) -> Result<Source, &'static str> {
    if input.len() > 2048
        || input
            .bytes()
            .any(|b| b.is_ascii_control() || b.is_ascii_whitespace())
    {
        return Err("invalid source");
    }
    let (kind, id) = if let Some(uri) = input.strip_prefix("spotify:") {
        let mut parts = uri.split(':');
        let kind = parse_kind(parts.next().ok_or("invalid source")?)?;
        let id = parts.next().ok_or("invalid source")?;
        if parts.next().is_some() {
            return Err("invalid source");
        }
        (kind, id.to_owned())
    } else if input.starts_with("https://open.spotify.com/") {
        let url = url::Url::parse(input).map_err(|_| "invalid source")?;
        if url.scheme() != "https"
            || url.host_str() != Some("open.spotify.com")
            || url.username() != ""
            || url.password().is_some()
            || url.port().is_some()
            || url.fragment().is_some()
        {
            return Err("invalid source");
        }
        let segments = url
            .path_segments()
            .ok_or("invalid source")?
            .collect::<Vec<_>>();
        if segments.len() != 2 {
            return Err("invalid source");
        }
        (parse_kind(segments[0])?, segments[1].to_owned())
    } else {
        return Err("invalid source");
    };

    if id.len() != 22 || !id.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return Err("invalid source");
    }
    Ok(Source { kind, id })
}

fn parse_kind(kind: &str) -> Result<Kind, &'static str> {
    match kind {
        "track" => Ok(Kind::Track),
        "album" => Ok(Kind::Album),
        "playlist" => Ok(Kind::Playlist),
        _ => Err("invalid source"),
    }
}

pub fn validate_expansion(
    expected: usize,
    kinds: &[String],
    position: i32,
    truncated: bool,
) -> Result<Vec<String>, &'static str> {
    if expected > MAX_ITEMS
        || expected != kinds.len()
        || position != 0
        || truncated
        || kinds.iter().any(|kind| kind != "track")
    {
        return Err("incomplete source");
    }
    Ok(kinds.to_vec())
}

#[derive(serde::Serialize)]
pub struct TrackDescriptor {
    pub uri: String,
    pub name: String,
    pub artists: Vec<String>,
    pub album: String,
    pub duration_ms: u32,
}

pub async fn resolve(
    session: &librespot::core::Session,
    source: Source,
) -> Result<Vec<TrackDescriptor>, &'static str> {
    use librespot::{
        core::SpotifyUri,
        metadata::{Album, Metadata, Playlist, Track},
    };
    let uri = SpotifyUri::from_uri(&format!(
        "spotify:{}:{}",
        match source.kind {
            Kind::Track => "track",
            Kind::Album => "album",
            Kind::Playlist => "playlist",
        },
        source.id
    ))
    .map_err(|_| "metadata unavailable")?;
    let ids = match source.kind {
        Kind::Track => vec![uri],
        Kind::Album => {
            let album = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                Album::get(session, &uri),
            )
            .await
            .map_err(|_| "metadata timeout")?
            .map_err(|_| "metadata unavailable")?;
            let ids = album.tracks().cloned().collect::<Vec<_>>();
            validate_expansion(
                ids.len(),
                &ids.iter().map(uri_kind).collect::<Vec<_>>(),
                0,
                false,
            )?;
            ids
        }
        Kind::Playlist => {
            let playlist = tokio::time::timeout(
                std::time::Duration::from_secs(30),
                Playlist::get(session, &uri),
            )
            .await
            .map_err(|_| "metadata timeout")?
            .map_err(|_| "metadata unavailable")?;
            if playlist.length < 0 {
                return Err("incomplete source");
            }
            let ids = playlist
                .contents
                .items
                .iter()
                .map(|item| item.id.clone())
                .collect::<Vec<_>>();
            validate_expansion(
                playlist.length as usize,
                &ids.iter().map(uri_kind).collect::<Vec<_>>(),
                playlist.contents.position,
                playlist.contents.is_truncated,
            )?;
            ids
        }
    };
    if ids.len() > MAX_ITEMS {
        return Err("incomplete source");
    }
    let mut tracks = Vec::with_capacity(ids.len());
    for id in ids {
        if uri_kind(&id) != "track" {
            return Err("incomplete source");
        }
        let track =
            tokio::time::timeout(std::time::Duration::from_secs(30), Track::get(session, &id))
                .await
                .map_err(|_| "metadata timeout")?
                .map_err(|_| "metadata unavailable")?;
        if track.name.len() > 4096
            || track.album.name.len() > 4096
            || track.artists.iter().any(|artist| artist.name.len() > 4096)
            || track.duration < 0
        {
            return Err("metadata unavailable");
        }
        tracks.push(TrackDescriptor {
            uri: track.id.to_string(),
            name: track.name,
            artists: track
                .artists
                .iter()
                .map(|artist| artist.name.clone())
                .collect(),
            album: track.album.name,
            duration_ms: track.duration as u32,
        });
    }
    Ok(tracks)
}

fn uri_kind(uri: &librespot::core::SpotifyUri) -> String {
    match uri {
        librespot::core::SpotifyUri::Track { .. } => "track".into(),
        librespot::core::SpotifyUri::Episode { .. } => "episode".into(),
        _ => "other".into(),
    }
}
