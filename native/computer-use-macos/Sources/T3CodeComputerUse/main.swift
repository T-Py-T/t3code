import ComputerUseMacOSCore
import Foundation

private actor ResponseWriter {
    private let encoder: JSONEncoder

    init() {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        self.encoder = encoder
    }

    func write(_ response: HostResponse) throws {
        FileHandle.standardOutput.write(try encoder.encode(response))
        FileHandle.standardOutput.write(Data([0x0a]))
    }
}

@main
struct T3CodeComputerUseMain {
    static func main() async {
        let decoder = JSONDecoder()
        let host = MacComputerUseHost()
        let writer = ResponseWriter()

        await withTaskGroup(of: Void.self) { requests in
            do {
                for try await line in FileHandle.standardInput.bytes.lines {
                    guard let data = line.data(using: .utf8), !data.isEmpty else { continue }
                    do {
                        switch try decoder.decode(HostCommand.self, from: data) {
                        case .cancel(let cancel):
                            await host.cancel(cancel)
                        case .request(let request):
                            requests.addTask {
                                let response = await host.handle(request)
                                try? await writer.write(response)
                            }
                        }
                    } catch {
                        FileHandle.standardError.write(Data("Invalid Computer Use command.\n".utf8))
                    }
                }
            } catch {
                FileHandle.standardError.write(Data("Computer Use input stream failed.\n".utf8))
            }
        }
    }
}
