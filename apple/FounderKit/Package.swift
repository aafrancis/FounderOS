// swift-tools-version: 6.0
// FounderKit: models and API client for the FounderOS backend, shared by the FounderOS app and
// (later) Wild Horse. Foundation only, so `swift test` runs on Linux (in Docker) as well as macOS.
import PackageDescription

let package = Package(
    name: "FounderKit",
    platforms: [.macOS(.v13), .iOS(.v16)],
    products: [
        .library(name: "FounderKit", targets: ["FounderKit"]),
    ],
    targets: [
        .target(name: "FounderKit"),
        .testTarget(name: "FounderKitTests", dependencies: ["FounderKit"]),
    ]
)
