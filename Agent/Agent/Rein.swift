//
//  Rein.swift
//  Agent
//
//  Created by Lena Armijo on 9/6/26.
//

import SwiftUI

private let harness = "https://3.129.88.202"
private let api = "/llmchat"
private let model = "gemma4:e4b"
private let showThinking = true
private let appID = Bundle.main.bundleIdentifier

private let Json = JSONDecoder()
struct Rein {
    private static var isThinking = false
    
    private func prepareRequest(_ harnessApi: URL, _ payload: OpenAIRequest) throws -> URLRequest {
        let requestBody = try JSONEncoder().encode(payload)
        
        var request = URLRequest(url: harnessApi)
        request.timeoutInterval = 1200 // for 20 minutes
        request.httpMethod = "POST"
        request.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        request.httpBody = requestBody
        
        return request
    }
    
    private func postPrompt(_ request: URLRequest) async throws -> URLSession.AsyncBytes {
        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        
        if let http = response as? HTTPURLResponse, http.statusCode != 200 {
            var msg: String? = nil
            if let data = try? await bytes.reduce(into: Data(), { $0.append($1) }) {
                msg = String(decoding: data, as: UTF8.self)
            }
            throw Exception(errorDescription: "\(http.statusCode): \(msg ?? HTTPURLResponse.localizedString(forStatusCode: http.statusCode))")
        }
        
        return bytes
    }
    
    private func processSse(_ bytes: URLSession.AsyncBytes, _ acc: inout SseAccumulator) async throws {
            var sseEvent = SseEvent.Message
            
            // AsyncSequence.lines skips empty lines,
            // must build lines from .characters instead:
            // https://developer.apple.com/forums/thread/725162
            var buffer = Data(capacity: 8192)
            for try await byte in bytes {
                if byte == UInt8(ascii: "\r") { continue } // ignore/skip `\r`
                if byte != UInt8(ascii: "\n") { buffer.append(byte); continue }
                
                let line = String(decoding: buffer, as: UTF8.self)
                buffer.removeAll(keepingCapacity: true)
                
                if line.isEmpty {
                    // SSE events are delimited by "\n\n"
                    
                    if sseEvent == .Error {
                        // show error message in content bubble
                        acc.completion.content.append("\n\n**SSE Error Event**: \(acc.errMsg.wrappedValue)\n\n")
                    }

                    // new SSE event, default to Message
                    sseEvent = .Message
                    continue
                }
                
                // parse SSE line
                            guard let splitAt = line.firstIndex(of: ":") else { continue }

                            // separate out `tag: tagline` from the SSE line
                            let tag = line[..<splitAt]
                            var tagline = line[line.index(after: splitAt)...]
                            // drop the first leading space (per SSE spec)
                            if tagline.first == " " { tagline = tagline.dropFirst() }

                            // "tag" can only be "data" or "event"
                            if tag == "data" {

                                // OpenAI's `/v1/chat/completions` uses "data: [DONE]"
                                                // to indicate end of stream
                                                if tagline.isEmpty || tagline == "[DONE]" { continue }
                                                
                                                do {
                                                    switch sseEvent {
                                                        // multiple data lines can belong to the same event
                                                        case .Message:
                                                        
                                                        // OpenAI's `/v1/chat/completions` API requires that
                                                                                    // a serialized JSON object follows a `data:` tag.
                                                                                    let openAIResponse = try Json.decode(OpenAIResponse.self, from: Data(tagline.utf8))
                                                                                    
                                                                                    // extract content from choices[0].delta.content.
                                                                                    // OpenAI defaults to generating only one completion
                                                                                    // choice when the 'n' parameter is not included in
                                                                                    // OpenAIRequest.
                                                                                    if let delta = openAIResponse.choices.first?.delta {
                                                                                        let content = decoratedContent(from: delta)
                                                                                        if !content.isEmpty {
                                                                                            acc.completion.content.append(content)
                                                                                            if acc.completion.timestamp.isEmpty {
                                                                                                if let model = openAIResponse.model { acc.completion.role = "assistant (\(model))" }
                                                                                                let created = openAIResponse.created ?? Date().timeIntervalSince1970
                                                                                                acc.completion.timestamp = Date(timeIntervalSince1970: created).ISO8601Format()
                                                                                            }
                                                                                        }
                                                                                    }
                                                                                    if let finishReason = openAIResponse.choices.first?.finish_reason,
                                                                                       finishReason == "length" || finishReason == "content_filter" {
                                                                                        acc.errMsg.wrappedValue += "LLM STREAM CUT OFF!"
                                                                                        sseEvent = .Error
                                                                                    }
                                                                                    
                                                            
                                                        case .Error:
                                                            // Json.decode removes escape characters
                                                            if let errline = try? Json.decode(String.self, from: Data(tagline.utf8)) {
                                                                acc.errMsg.wrappedValue += errline
                                                            } else {
                                                                acc.errMsg.wrappedValue += String(tagline)
                                                            }
                                                        default:
                                                            acc.errMsg.wrappedValue += "\n\n**Unknown SSE event**: \(tagline)\n\n"
                                                    }
                                                } catch {
                                                    acc.errMsg.wrappedValue += "\n\n**SSE stream JSON decode**: \(error)\n\(tagline)\n"
                                                }
                                
                            } else if tag == "event" {
                                sseEvent = switch tagline {
                                    case "error",   "Error",   "ERROR"   : .Error
                                    case "message", "Message", "MESSAGE" : .Message
                                    default: .Unknown
                                }
                            }
                     

            }
        }
        

    private func decoratedContent(from delta: Delta) -> String {
            if let content = delta.content.nilIfEmpty {
                let result = Rein.isThinking ? "\n</think>\n\n" + content : content
                Rein.isThinking = false
                return result
            }
            
            if showThinking {
                if let reason = (delta.reasoning_content.nilIfEmpty ?? delta.reasoning.nilIfEmpty) {
                    let result = Rein.isThinking ? reason : "<think>\n" + reason
                    Rein.isThinking = true
                    return result
                }
            }
            
            return ""
        }
    
    func llmPrompt(_ messages: [Message], completion: Chat, errMsg: Binding<String>) async {
            
            guard let harnessApi = URL(string: "\(harness)\(api)") else {
                errMsg.wrappedValue = "Bad harness URL \(harness)\(api)"
                return
            }

            // prepare request
            let openAIRequest = OpenAIRequest(
                model: model,
                messages: messages,
                appID: appID
            )
            let request = Result { try prepareRequest(harnessApi, openAIRequest) }
            guard case .success(let request) = request else {
                if case .failure(let error) = request {
                    errMsg.wrappedValue = "Prepare request failed \(error)"
                }
                return
            }

            // post request
            //let bytes = await Result { try await postPrompt(request) }
            //guard case .success(let bytes) = bytes else {
              //  if case .failure(let error) = bytes {
                //    errMsg.wrappedValue = "Connect to harness failed \(error)"
                //}
                //return
            //}
        
        let bytes: URLSession.AsyncBytes

        do {
            bytes = try await postPrompt(request)
        } catch {
            errMsg.wrappedValue = "Connect to harness failed \(error)"
            return
        }
            // process response
            var acc = SseAccumulator(completion: completion, errMsg: errMsg)
            do {
                try await processSse(bytes, &acc)
            } catch {
                errMsg.wrappedValue = "SSE parsing failed \(error)"
                completion.content.append("\n\n**\(errMsg.wrappedValue)**\n\n")
            }
        }

}

struct Message: Encodable {
    let role: String
    let content: String?
    
    init(role: String = "user", content: String = "") {
        self.role = role
        self.content = content
    }
}

struct OpenAIRequest: Encodable {
    let model: String
    //let max_tokens = 8192 // some models require it
    let messages: [Message]
    let stream = true       // always streaming
    let appID: String?
}

struct OpenAIResponse: Decodable {
    let model: String?
    let choices: [Choice]   // guaranteed only one completion choice
    let created: Double?
    
    struct Choice: Decodable {
        let delta: Delta
        let finish_reason: String?
    }
}

struct Delta: Decodable {
    let content: String?
    let reasoning: String?
    let reasoning_content: String?
}

enum SseEvent { case Error, Message, Unknown }

struct SseAccumulator {
    let completion: Chat
    let errMsg: Binding<String>
}
