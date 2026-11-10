import XCTest
@testable import FounderKit

/// Runs FounderKit against a REAL FounderOS server. Skipped unless FOUNDEROS_URL is set, so `swift test`
/// stays offline by default. Use a throwaway instance (its own database): this test turns the kill switch on.
///
///   PORT=4199 GLADOS_DB=/tmp/fk-live.db node scripts/serve.mjs dev
///   FOUNDEROS_URL=http://127.0.0.1:4199 swift test --filter LiveServerTests
///
/// A loopback instance has no password, so no login is needed. For an instance behind a password, set
/// FOUNDEROS_PASSWORD as well.
final class LiveServerTests: XCTestCase {
    private func liveClient() async throws -> FounderClient {
        guard let raw = ProcessInfo.processInfo.environment["FOUNDEROS_URL"], let url = URL(string: raw) else {
            throw XCTSkip("set FOUNDEROS_URL to run against a real server")
        }
        let client = FounderClient(baseURL: url)
        if let password = ProcessInfo.processInfo.environment["FOUNDEROS_PASSWORD"] {
            try await client.login(password: password)
        }
        return client
    }

    func testDecodesTheRealApprovalsState() async throws {
        let state = try await liveClient().approvals()
        // Shape only: the instance may hold any data. What matters is that every field decodes.
        XCTAssertEqual(state.killed, state.switch.killed)
        XCTAssertFalse(state.writesEnabled, "a throwaway instance must not have outbound writes on")
        for grant in state.grants { XCTAssertFalse(grant.channel.isEmpty) }
        for action in state.open { XCTAssertEqual(action.status, .proposed) }
    }

    func testAProposalOnAChannelWithNoGrantIsRefusedWithTheServersCode() async throws {
        let client = try await liveClient()
        let proposal = Proposal(channel: "social.fk-live-test", kind: "post", title: "t", content: "c", target: "x", proposedBy: "founderkit-live-test")
        do {
            _ = try await client.propose(proposal)
            XCTFail("an unarmed, unknown channel must refuse")
        } catch let error as FounderError {
            guard case let .refused(status, code, message) = error else { return XCTFail("wrong case \(error)") }
            XCTAssertEqual(status, 403)
            XCTAssertEqual(code, "no_grant")
            XCTAssertTrue(message.contains("no armed grant"), message)
        }
    }

    func testDecidingAnUnknownProposalIsRefusedNotCrashed() async throws {
        let client = try await liveClient()
        do {
            _ = try await client.decide("does-not-exist", .approve)
            XCTFail("an unknown id must refuse")
        } catch let error as FounderError {
            guard case let .refused(status, code, _) = error else { return XCTFail("wrong case \(error)") }
            XCTAssertTrue((400..<500).contains(status), "status \(status)")
            XCTAssertFalse(code.isEmpty)
        }
    }

    func testTheKillSwitchWorksWithNoSecretAndShowsInTheState() async throws {
        let client = try await liveClient()
        try await client.kill()
        let state = try await client.approvals()
        XCTAssertTrue(state.killed)
        XCTAssertTrue(state.switch.killed)
    }
}
