//
//  Toolbox.swift
//  Agent
//
//  Created by Lena Armijo on 10/6/26.
//
import Foundation

private let Json = JSONDecoder()

fileprivate func jsonToSchema(_ tool: String) -> OpenAIToolSchema {
    guard let url = Bundle.main.url(
        forResource: tool,
        withExtension: "json"
    ),
    let data = try? Data(contentsOf: url) else {
        fatalError("Failed to find \(tool).json in bundle")
    }

    do {
        return try Json.decode(
            OpenAIToolSchema.self,
            from: data
        )
    } catch {
        fatalError("Failed to decode \(tool).json: \(error)")
    }
}

func getLocation(_ argv: [String]) async -> String {
    guard let fix = LocManagerViewModel.shared.location else {
        return "409 Current location unavailable"
    }

    return "latitude: \(fix.lat), longitude: \(fix.lon)"
}

func getLocAuth(_ argv: [String]) async -> String {
    guard let provided = argv.first,
          let current = Ticket.shared.ticket,
          current == provided else {
        return """
        401 Unauthorized. Ask the user whether to sign in again and call get_auth for a fresh ticket.
        """
    }

    return await getLocation([])
}

func getAuth(_ argv: [String]) async -> String {
    repeat {
        if let ticket = Ticket.shared.ticket {
            return "Authorization ticket is: \(ticket)"
        }

        if let vm = Ticket.shared.vm {
            await withUnsafeContinuation { getAuthAt in
                vm.signinCompletion = {
                    getAuthAt.resume()
                }

                vm.getSignedin = true
            }
        }

        if Ticket.shared.ticket == nil {
            return """
            401 Unauthorized. Complete the prompt by informing user that task cannot be completed due to failed authorization.
            """
        }
    } while true
}

func moveMapTool(_ argv: [String]) async -> String {
    guard argv.count == 3,
          let lat = Double(argv[0]),
          let lon = Double(argv[1]),
          lat.isFinite,
          lon.isFinite,
          (-90...90).contains(lat),
          (-180...180).contains(lon) else {
        return "400 Invalid map coordinates"
    }

    guard let current = Ticket.shared.ticket,
          current == argv[2] else {
        return """
        401 Unauthorized. Obtain a fresh ticket using get_auth and ask the user to retry.
        """
    }

    guard let vm = Ticket.shared.vm else {
        return "500 Map unavailable"
    }

    for _ in 0..<20 {
        if vm.mapReady && vm.mapPresented {
            return vm.applyMapMove(
                latitude: lat,
                longitude: lon
            )
        }

        try? await Task.sleep(for: .milliseconds(250))
    }

    return "409 Current location unavailable; map not moved"
}

struct OpenAIToolSchema: Codable {
    let type: String = "function"
    let function: OpenAISchemaFunction

    enum CodingKeys: String, CodingKey {
        case type
        case function
    }
}

struct OpenAISchemaFunction: Codable {
    let name: String
    let description: String
    let parameters: OpenAIFunctionParams?
}

struct OpenAIFunctionParams: Codable {
    let type: String
    let properties: [String: OpenAIParamProp]?
    let required: [String]?
}

struct OpenAIParamProp: Codable {
    let type: String
    let description: String
    let enum_: [String]?
}

typealias ToolFunction = ([String]) async -> String

struct Tool {
    let schema: OpenAIToolSchema
    let function: ToolFunction
}

struct Toolbox {
    let tools: [String: Tool]

    init() {
        self.tools = [
            "get_auth": Tool(
                schema: jsonToSchema("get_auth"),
                function: getAuth
            ),
            "get_loc_auth": Tool(
                schema: jsonToSchema("get_loc_auth"),
                function: getLocAuth
            ),
            "move_map": Tool(
                schema: jsonToSchema("move_map"),
                function: moveMapTool
            )
        ]
    }

    func schemas() -> [OpenAIToolSchema] {
        tools.values.map { $0.schema }
    }

    func invoke(function: OpenAIFunction) async -> String? {
        guard let name = function.name,
              let tool = tools[name] else {
            return nil
        }

        guard let argsJson = function.arguments,
              let argsData = argsJson.data(using: .utf8),
              let args = try? JSONSerialization.jsonObject(
                with: argsData
              ) as? [String: Any] else {
            return "bad tool arguments JSON"
        }

        let argv: [String] = (
            tool.schema.function.parameters?.required ?? []
        ).map { label in
            switch args[label] {
            case let value as String:
                return value
            case let value?:
                return String(describing: value)
            default:
                return ""
            }
        }

        return await tool.function(argv)
    }
}
