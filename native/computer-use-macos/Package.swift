// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "T3CodeComputerUse",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "ComputerUseMacOSCore", targets: ["ComputerUseMacOSCore"]),
        .executable(name: "T3CodeComputerUse", targets: ["T3CodeComputerUse"]),
    ],
    targets: [
        .target(
            name: "ComputerUseMacOSCore",
            path: "Sources/ComputerUseMacOSCore"
        ),
        .executableTarget(
            name: "T3CodeComputerUse",
            dependencies: ["ComputerUseMacOSCore"],
            path: "Sources/T3CodeComputerUse"
        ),
        .testTarget(
            name: "ComputerUseMacOSCoreTests",
            dependencies: ["ComputerUseMacOSCore"],
            path: "Tests/ComputerUseMacOSCoreTests"
        ),
    ]
)
