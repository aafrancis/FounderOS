import Foundation

// Shapes of the FounderOS approval queue API (lib/db-ext/approvals.ts, app/api/approvals/*).
// Timestamps stay as the server's ISO strings: the app shows them, the server owns their meaning.

/// Where an action is in its life. An unknown value from a newer server decodes as `.unknown`
/// instead of failing the whole screen.
public enum ActionStatus: String, Codable, Sendable, Equatable {
    case proposed, approved, rejected, executing, executed, failed, expired, unknown

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = ActionStatus(rawValue: raw) ?? .unknown
    }

    /// Waiting for a human decision.
    public var isOpen: Bool { self == .proposed }
}

public enum GrantMode: String, Codable, Sendable, Equatable {
    case ask, auto
}

public struct Grant: Codable, Sendable, Equatable {
    public let channel: String
    public let mode: GrantMode
    public let dailyCapCount: Int
    public let dailyCapCents: Int
    public let armed: Bool
    public let armedAt: String?
    public let updatedAt: String
}

/// One proposed send, spend or publish, with everything the human needs to judge it.
public struct ApprovalAction: Codable, Sendable, Equatable, Identifiable {
    public let id: String
    public let channel: String
    public let kind: String
    public let title: String
    public let content: String
    public let target: String
    public let costCents: Int
    public let status: ActionStatus
    public let proposedBy: String
    public let proposedAt: String
    public let decidedAt: String?
    public let decidedBy: String?
    public let executedAt: String?
    public let result: String?
}

public struct SwitchState: Codable, Sendable, Equatable {
    public let killed: Bool
    public let changedAt: String?
    public let changedBy: String?
}

public struct LogRow: Codable, Sendable, Equatable, Identifiable {
    public let id: Int
    public let at: String
    public let event: String
    public let channel: String?
    public let actionId: String?
    public let actor: String
    public let detail: String
}

/// `GET /api/approvals`: the whole screen in one read.
public struct ApprovalsState: Codable, Sendable, Equatable {
    public let killed: Bool
    public let `switch`: SwitchState
    public let writesEnabled: Bool
    public let armConfigured: Bool
    public let grants: [Grant]
    public let open: [ApprovalAction]
    public let recent: [ApprovalAction]
    public let log: [LogRow]
}

/// What the operator can do to a proposal. `run` re-runs an approved action that did not run yet.
public enum Decision: String, Codable, Sendable, Equatable {
    case approve, reject, run
}

/// A filed proposal (`POST /api/approvals`). The app files these on behalf of a person, never by itself.
public struct Proposal: Codable, Sendable, Equatable {
    public var channel: String
    public var kind: String
    public var title: String
    public var content: String
    public var target: String
    public var costCents: Int
    public var proposedBy: String

    public init(channel: String, kind: String, title: String, content: String, target: String, costCents: Int = 0, proposedBy: String) {
        self.channel = channel
        self.kind = kind
        self.title = title
        self.content = content
        self.target = target
        self.costCents = costCents
        self.proposedBy = proposedBy
    }
}

/// How an approval ended up: it ran, or the server said why it did not (the action stays approved).
public enum Execution: Sendable, Equatable, Decodable {
    case ran
    case notRun(code: String, message: String)

    private struct Failure: Decodable { let code: String; let error: String }

    public init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let s = try? c.decode(String.self), s == "ran" {
            self = .ran
        } else {
            let f = try c.decode(Failure.self)
            self = .notRun(code: f.code, message: f.error)
        }
    }
}

public struct DecisionResult: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let action: ApprovalAction
    public let execution: Execution?
}

public struct ProposalResult: Decodable, Sendable, Equatable {
    public let ok: Bool
    public let action: ApprovalAction
    public let autoApproved: Bool?
}
