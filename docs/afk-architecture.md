# AFK channel update flow

Each community may select one existing voice channel as its AFK destination. The database stores
that channel and the timeout. Occupancy and device activity live in the server process with the
voice calls; they are short-lived and never contain media keys. An AFK occupant has no LiveKit
session.

```mermaid
sequenceDiagram
    participant Page as Voice page
    participant Core as Client worker
    participant API as dillad AFK routes
    participant SFU as LiveKit room
    participant GW as Community gateway
    participant Peers as Other member pages

    Page->>SFU: Join community voice room
    SFU->>API: Admit device and start inactivity timer
    Page->>Core: Input or microphone speech in a voice call
    Core->>API: POST /afk/activity [source channel]
    API->>API: Record server receipt time for this device
    Note over API: Retry loop checks elapsed time even if the page sleeps
    API->>SFU: Remove this device and all its media tracks
    SFU-->>API: Device removed
    API->>API: Record silent AFK occupancy
    API->>GW: community_changed [community id]
    GW-->>Core: community_changed
    GW-->>Peers: community_changed
    Core->>API: GET /afk snapshot
    Peers->>API: GET /afk snapshot
    API-->>Core: Visible AFK occupants
    API-->>Peers: Visible AFK occupants
    Core-->>Page: AFK slice; close the former call session
    Page->>Core: Leave AFK or join another voice room
    Core->>API: DELETE /afk
    API->>GW: community_changed
```

The server refuses new call tokens and `/rtc` admission for the AFK destination. It also refuses
rejoining the source call while a device occupies AFK, including attempts made by a suspended
page as it wakes. The existing voice leave and membership reconciliation remove the source call's
MLS leaf. A fresh AFK snapshot follows every reconnect; `community_changed` carries no occupant
details, so each member only sees a destination they can access.
