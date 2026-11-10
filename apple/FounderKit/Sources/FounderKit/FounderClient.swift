import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// The one seam to the network. Tests use a canned transport; the app uses `URLSessionTransport`.
public protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

public struct URLSessionTransport: HTTPTransport {
    private let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw FounderError.invalidResponse }
        return (data, http)
    }
}

public enum FounderError: Error, Equatable, Sendable {
    /// The server said no, with its code and plain-English reason (for example 423 "killed").
    case refused(status: Int, code: String, message: String)
    case invalidResponse
    case decoding(String)
}

/// Client for the FounderOS web API. It holds no credentials: login sets the session cookie on the
/// transport's session, and the app never holds send, spend or publish keys.
public struct FounderClient: Sendable {
    public let baseURL: URL
    private let transport: any HTTPTransport

    public init(baseURL: URL, transport: any HTTPTransport = URLSessionTransport()) {
        self.baseURL = baseURL
        self.transport = transport
    }

    // MARK: Session

    /// `POST /api/auth/login`. Throws `.refused` on a wrong password (401) or a throttle (429).
    public func login(password: String) async throws {
        _ = try await post("api/auth/login", ["password": password]) as Data
    }

    // MARK: Approvals

    public func approvals() async throws -> ApprovalsState {
        try decode(try await get("api/approvals"))
    }

    public func propose(_ proposal: Proposal) async throws -> ProposalResult {
        try decode(try await post("api/approvals", proposal))
    }

    /// Approving also runs the action once when an executor is registered and writes are on; the
    /// result says which happened (`execution`).
    public func decide(_ id: String, _ decision: Decision) async throws -> DecisionResult {
        try decode(try await post("api/approvals/\(id)", ["decision": decision.rawValue]))
    }

    /// The kill switch: needs no secret and always works. Lifting it needs the arming secret and is
    /// deliberately not in this client yet (it belongs with the signed-approval flow).
    public func kill() async throws {
        _ = try await post("api/approvals/kill", ["action": "kill"]) as Data
    }

    // MARK: Plumbing

    private func url(_ path: String) -> URL {
        baseURL.appendingPathComponent(path)
    }

    private func get(_ path: String) async throws -> Data {
        var req = URLRequest(url: url(path))
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        return try await run(req)
    }

    private func post<B: Encodable>(_ path: String, _ body: B) async throws -> Data {
        var req = URLRequest(url: url(path))
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = try JSONEncoder().encode(body)
        return try await run(req)
    }

    private func run(_ req: URLRequest) async throws -> Data {
        let (data, http) = try await transport.send(req)
        guard (200..<300).contains(http.statusCode) else {
            throw Self.refusal(status: http.statusCode, data: data)
        }
        return data
    }

    private struct ErrorBody: Decodable {
        let error: String?
        let code: String?
    }

    static func refusal(status: Int, data: Data) -> FounderError {
        let body = try? JSONDecoder().decode(ErrorBody.self, from: data)
        return .refused(status: status, code: body?.code ?? "http_\(status)", message: body?.error ?? "The server refused the request (HTTP \(status)).")
    }

    private func decode<T: Decodable>(_ data: Data) throws -> T {
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw FounderError.decoding(String(describing: error))
        }
    }
}
