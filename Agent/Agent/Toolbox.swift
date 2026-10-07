//
//  Toolbox.swift
//  Agent
//
//  Created by Lena Armijo on 10/6/26.
//
import Foundation

private let Json = JSONDecoder()

fileprivate func jsonToSchema(_ tool: String) -> OpenAIToolSchema {
    guard let url = Bundle.main.url(forResource: tool, withExtension: "json"),
          let data = try? Data(contentsOf: url) else {
        fatalError("Failed to find \(tool).json in bundle")
    }

    do {
        return try Json.decode(OpenAIToolSchema.self, from: data)
    } catch {
        fatalError("Failed to decode \(tool).json: \(error)")
    }
}


func getLocation(_ argv: [String]) async -> String {
    "latitude: \(LocManagerViewModel.shared.location.lat), longitude: \(LocManagerViewModel.shared.location.lon)"
}

struct OpenAIToolSchema: Codable {
    let type: String = "function"
    let function: OpenAISchemaFunction
    
    enum CodingKeys: String, CodingKey {
        case type = "type"
        case function = "function"
    }
}

struct OpenAISchemaFunction: Codable {
    let name: String
    let description: String
    let parameters: OpenAIFunctionParams?
}

struct OpenAIFunctionParams: Codable {
    let type: String
    let properties: [String:OpenAIParamProp]?
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
            "get_location": Tool(schema: jsonToSchema("get_location"), function: getLocation),
        ]
    }

    func schemas() -> [OpenAIToolSchema] {
        return tools.values.map { $0.schema }
    }

    // to invoke the tool
    func invoke(function: OpenAIFunction) async -> String? {
            guard let name = function.name, let tool = tools[name] else { return nil }
            guard let argsJson = function.arguments,
                let argsData = argsJson.data(using: .utf8),
                let args = try? JSONSerialization.jsonObject(with: argsData) as? [String: Any] else {
                return "bad tool arguments JSON"
            }

            // get args in parameters.required order, they may arrive out of order from the back end
            let argv: [String] = (tool.schema.function.parameters?.required ?? []).map { label in
                switch args[label] {
                case let value as String:   return value
                case let value?:            return String(describing: value)
                default:                    return ""
                }
            }
            return await tool.function(argv)
        }

}
