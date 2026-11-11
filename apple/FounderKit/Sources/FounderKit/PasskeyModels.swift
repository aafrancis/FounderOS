import Foundation

// Shapes of the hard-line passkey approval API (SH-0277): lib/passkeys.ts,
// app/api/approvals/[id]/passkey/route.ts, app/api/passkey/route.ts and
// app/api/approvals/hard-line/route.ts. Types only: the Mac session wires them
// into FounderClient and the app's Approve button (ASAuthorizationController).
//
// Flow for one hard-line approval:
//   1. POST api/approvals/<id>/passkey  {"step":"options"}            -> PasskeyApprovalOptions
//   2. ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: options.rpId)
//        .createCredentialAssertionRequest(challenge: base64url-decoded options.challenge)
//      Face ID runs here. Build a PasskeyAssertion from the result.
//   3. POST api/approvals/<id>/passkey  {"step":"verify","response":<PasskeyAssertion>} -> PasskeyApproveResult
// A hard-line action is never approved by `decide(_:_:)` with `.approve`: the server answers
// 403 with code "passkey_required". `.reject` (Deny) still works.

public let hardLineKind = "hard-line"

extension ApprovalAction {
    /// Approved only with the founder's passkey (Face ID).
    public var isHardLine: Bool { kind == hardLineKind }

    /// The summary, exact action and undo the agent filed, when this is a hard-line action.
    public var hardLineDetail: HardLineDetail? {
        guard isHardLine, let data = content.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(HardLineDetail.self, from: data)
    }
}

/// What an agent asked for, stored as the hard-line action's `content`.
public struct HardLineDetail: Codable, Sendable, Equatable {
    public let summary: String
    public let action: String
    public let undo: String
}

/// `GET api/approvals/hard-line?id=<id>` (the agent's poll; the app can read it too).
public struct HardLineStatus: Codable, Sendable, Equatable {
    public let id: String
    public let status: ActionStatus
    public let decidedBy: String?
    public let decidedAt: String?
    public let expiresAt: String?
}

/// One credential the server allows for the assertion.
public struct PasskeyAllowedCredential: Codable, Sendable, Equatable {
    /// base64url credential id.
    public let id: String
    public let type: String
    public let transports: [String]?
}

/// WebAuthn `PublicKeyCredentialRequestOptionsJSON`, as the server sends it.
public struct PasskeyRequestOptions: Codable, Sendable, Equatable {
    /// base64url. Decodes to "hard-line:<action id>:<nonce>"; single use, 5 minutes.
    public let challenge: String
    public let rpId: String?
    public let timeout: Int?
    public let userVerification: String?
    public let allowCredentials: [PasskeyAllowedCredential]?
}

/// Step 1 reply: `{ ok, options, expiresAt }`.
public struct PasskeyApprovalOptions: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let options: PasskeyRequestOptions
    public let expiresAt: String
}

/// WebAuthn `AuthenticationResponseJSON`: what step 3 sends. All binary fields are base64url.
public struct PasskeyAssertion: Codable, Sendable, Equatable {
    public struct Response: Codable, Sendable, Equatable {
        public var clientDataJSON: String
        public var authenticatorData: String
        public var signature: String
        public var userHandle: String?

        public init(clientDataJSON: String, authenticatorData: String, signature: String, userHandle: String? = nil) {
            self.clientDataJSON = clientDataJSON
            self.authenticatorData = authenticatorData
            self.signature = signature
            self.userHandle = userHandle
        }
    }

    public var id: String
    public var rawId: String
    public var type: String = "public-key"
    public var response: Response
    public var clientExtensionResults: [String: String] = [:]
    public var authenticatorAttachment: String? = "platform"

    public init(credentialId: String, response: Response) {
        self.id = credentialId
        self.rawId = credentialId
        self.response = response
    }
}

/// Step 3 body.
public struct PasskeyVerifyRequest: Encodable, Sendable {
    public let step = "verify"
    public let response: PasskeyAssertion

    public init(response: PasskeyAssertion) {
        self.response = response
    }
}

/// Step 3 reply on success; refusals arrive as `FounderError.refused` with a code such as
/// `challenge_not_for_this_approval`, `challenge_used`, `challenge_expired`, `unknown_credential`
/// or `assertion_invalid`.
public struct PasskeyApproveResult: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let action: ApprovalAction
}

/// `GET api/passkey`: is passkey approval configured, and which passkeys are registered.
public struct PasskeyStatus: Codable, Sendable, Equatable {
    public struct Credential: Codable, Sendable, Equatable, Identifiable {
        public let id: String
        public let label: String
        public let createdAt: String
        public let lastUsedAt: String?
    }

    public let configured: Bool
    public let rpID: String?
    public let credentials: [Credential]
}
