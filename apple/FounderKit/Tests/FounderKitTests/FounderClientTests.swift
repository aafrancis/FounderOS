import XCTest
@testable import FounderKit
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Canned transport: records every request, answers from a queue of (status, json).
final class MockTransport: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var replies: [(Int, String)]
    private(set) var requests: [URLRequest] = []

    init(_ replies: [(Int, String)]) { self.replies = replies }

    /// Synchronous on purpose: Swift 6 forbids bare lock()/unlock() inside async functions.
    private func next(for request: URLRequest) -> (Int, String) {
        lock.withLock {
            requests.append(request)
            return replies.isEmpty ? (500, "{}") : replies.removeFirst()
        }
    }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (status, body) = next(for: request)
        let http = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
        return (Data(body.utf8), http)
    }
}

private let actionJSON = """
{"id":"a1","channel":"social.instagram","kind":"post","title":"Reel 12","content":"Caption text","target":"@properfrancis",
 "costCents":0,"status":"proposed","proposedBy":"content-os","proposedAt":"2026-11-10T10:00:00.000Z",
 "decidedAt":null,"decidedBy":null,"executedAt":null,"result":null}
"""

private let stateJSON = """
{"killed":true,"switch":{"killed":true,"changedAt":null,"changedBy":null},"writesEnabled":false,"armConfigured":false,
 "grants":[{"channel":"social.instagram","mode":"ask","dailyCapCount":3,"dailyCapCents":0,"armed":false,"armedAt":null,"updatedAt":"2026-11-10T09:00:00.000Z"}],
 "open":[\(actionJSON)],"recent":[],
 "log":[{"id":1,"at":"2026-11-10T10:00:00.000Z","event":"propose","channel":"social.instagram","actionId":"a1","actor":"content-os","detail":""}]}
"""

final class FounderClientTests: XCTestCase {
    private let base = URL(string: "http://alienware.tailb2a051.ts.net:4100")!

    func testDecodesTheWholeApprovalsScreenAndStartsKilled() async throws {
        let client = FounderClient(baseURL: base, transport: MockTransport([(200, stateJSON)]))
        let state = try await client.approvals()
        XCTAssertTrue(state.killed)
        XCTAssertFalse(state.writesEnabled)
        XCTAssertFalse(state.armConfigured)
        XCTAssertEqual(state.grants.first?.armed, false)
        XCTAssertEqual(state.open.first?.status, .proposed)
        XCTAssertEqual(state.open.first?.content, "Caption text")
        XCTAssertEqual(state.log.first?.actionId, "a1")
    }

    func testUnknownStatusFromANewerServerDoesNotBreakTheScreen() throws {
        let json = actionJSON.replacingOccurrences(of: "\"proposed\"", with: "\"paused-by-future-server\"")
        let action = try JSONDecoder().decode(ApprovalAction.self, from: Data(json.utf8))
        XCTAssertEqual(action.status, .unknown)
        XCTAssertFalse(action.status.isOpen)
    }

    func testDecideSendsTheDecisionToTheRightPath() async throws {
        let mock = MockTransport([(200, "{\"ok\":true,\"action\":\(actionJSON),\"execution\":\"ran\"}")])
        let result = try await FounderClient(baseURL: base, transport: mock).decide("a1", .approve)
        XCTAssertEqual(result.execution, .ran)
        let req = try XCTUnwrap(mock.requests.first)
        XCTAssertEqual(req.httpMethod, "POST")
        XCTAssertEqual(req.url?.path, "/api/approvals/a1")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Content-Type"), "application/json")
        let body = try JSONSerialization.jsonObject(with: try XCTUnwrap(req.httpBody)) as? [String: String]
        XCTAssertEqual(body, ["decision": "approve"])
    }

    func testApprovedButNotRunIsReportedWithItsReason() async throws {
        let reply = "{\"ok\":true,\"action\":\(actionJSON),\"execution\":{\"code\":\"writes_off\",\"error\":\"Outbound writes are off\"}}"
        let result = try await FounderClient(baseURL: base, transport: MockTransport([(200, reply)])).decide("a1", .approve)
        XCTAssertEqual(result.execution, .notRun(code: "writes_off", message: "Outbound writes are off"))
    }

    func testRefusalsCarryTheServersCodeAndReason() async {
        let mock = MockTransport([(423, "{\"error\":\"The kill switch is on\",\"code\":\"killed\"}")])
        let client = FounderClient(baseURL: base, transport: mock)
        let proposal = Proposal(channel: "social.instagram", kind: "post", title: "t", content: "c", target: "x", proposedBy: "app")
        do {
            _ = try await client.propose(proposal)
            XCTFail("should have been refused")
        } catch let error as FounderError {
            XCTAssertEqual(error, .refused(status: 423, code: "killed", message: "The kill switch is on"))
        } catch {
            XCTFail("wrong error \(error)")
        }
    }

    func testAnErrorWithoutABodyStillSaysSomethingPlain() async {
        let client = FounderClient(baseURL: base, transport: MockTransport([(502, "<html>bad gateway</html>")]))
        do {
            _ = try await client.approvals()
            XCTFail("should have thrown")
        } catch let error as FounderError {
            guard case let .refused(status, code, message) = error else { return XCTFail("wrong case") }
            XCTAssertEqual(status, 502)
            XCTAssertEqual(code, "http_502")
            XCTAssertFalse(message.isEmpty)
        } catch {
            XCTFail("wrong error \(error)")
        }
    }

    func testLoginPostsThePasswordAndWrongPasswordIsRefused() async throws {
        let mock = MockTransport([(401, "{\"error\":\"wrong password\"}")])
        let client = FounderClient(baseURL: base, transport: mock)
        do {
            try await client.login(password: "nope")
            XCTFail("should have been refused")
        } catch let error as FounderError {
            XCTAssertEqual(error, .refused(status: 401, code: "http_401", message: "wrong password"))
        }
        let req = try XCTUnwrap(mock.requests.first)
        XCTAssertEqual(req.url?.path, "/api/auth/login")
        let body = try JSONSerialization.jsonObject(with: try XCTUnwrap(req.httpBody)) as? [String: String]
        XCTAssertEqual(body, ["password": "nope"])
    }

    func testKillNeedsNoSecretAndSendsTheKillAction() async throws {
        let mock = MockTransport([(200, "{\"ok\":true}")])
        try await FounderClient(baseURL: base, transport: mock).kill()
        let req = try XCTUnwrap(mock.requests.first)
        XCTAssertEqual(req.url?.path, "/api/approvals/kill")
        let body = try JSONSerialization.jsonObject(with: try XCTUnwrap(req.httpBody)) as? [String: String]
        XCTAssertEqual(body, ["action": "kill"])
    }

    func testProposeEncodesEveryFieldTheQueueRequires() async throws {
        let mock = MockTransport([(201, "{\"ok\":true,\"action\":\(actionJSON),\"autoApproved\":false}")])
        let p = Proposal(channel: "email.reply", kind: "draft", title: "Re: Solentive", content: "Hi", target: "a@b.com", costCents: 0, proposedBy: "founderos-app")
        let result = try await FounderClient(baseURL: base, transport: mock).propose(p)
        XCTAssertEqual(result.autoApproved, false)
        let sent = try JSONDecoder().decode(Proposal.self, from: try XCTUnwrap(mock.requests.first?.httpBody))
        XCTAssertEqual(sent, p)
    }
}
