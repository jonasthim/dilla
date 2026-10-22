package client

import (
	"context"
	"net/http"

	"github.com/jonasthim/dilla/internal/cborx"
	"github.com/jonasthim/dilla/internal/id"
)

const maxInteractionAdmissionResponse = 4096

// IssueBotInteractionAdmission obtains the installation-bound, server-signed
// admission receipt. The exact CBOR [payload, signature] is returned for native
// verification; this HTTP client does not treat its contents as authority.
func (s *Session) IssueBotInteractionAdmission(ctx context.Context, installation, requestID, group, participant, participantDevice id.ID) ([]byte, error) {
	if s == nil || s.c == nil || s.token == "" || requestID.IsZero() || group.IsZero() || participant.IsZero() || participantDevice.IsZero() {
		return nil, ErrInvalidConfig
	}
	inst, err := pathID(installation)
	if err != nil {
		return nil, err
	}
	request, err := encode([]any{requestID, group, participant, participantDevice})
	if err != nil {
		return nil, err
	}
	raw, _, err := s.c.do(ctx, s.token, http.MethodPost,
		"bot-runtime/installations/"+inst+"/interaction-admissions",
		nil, request, maxInteractionAdmissionResponse, false)
	if err != nil {
		return nil, err
	}
	var response []any
	if len(raw) > maxInteractionAdmissionResponse || cborx.Unmarshal(raw, &response) != nil || len(response) != 2 {
		return nil, ErrProtocol
	}
	if payload, ok := asBytes(response[0], -1); !ok || len(payload) == 0 || len(payload) > maxInteractionAdmissionResponse-80 {
		return nil, ErrProtocol
	}
	if _, ok := asBytes(response[1], 64); !ok {
		return nil, ErrProtocol
	}
	return append([]byte(nil), raw...), nil
}
