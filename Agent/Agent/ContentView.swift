//
//  ContentView.swift
//  Agent
//
//  Created by Lena Armijo on 9/4/26.
//

import SwiftUI

struct SubmitButton: View {
    @Environment(AppViewModel.self) private var vm
    
    @State private var isSending = false

    var body: some View {
        Button {
            isSending = true

            let chat = Chat(content: vm.message)
            vm.conversation.append(chat)
            
            // pass chat to harness in an array of `messages`
            // but Swift encoder cannot serialize @Observable hidden
            // variable correctly (_content in this case) so must
            // manually convert the hidden Chat._content to Message.content
            let messages = [Message(role: chat.role, content: chat.content)]
            
            // prepare completion placeholder
            let completion = Chat(role: "assistant",
                                content: "", timestamp: "") // placeholder for assistant's streaming completion
            vm.conversation.append(completion)
            
            Task (priority: .background){
                await vm.rein.llmPrompt(messages, completion: completion, errMsg: Bindable(vm).errMsg)
                // cleanup
                                vm.message = ""
                                isSending = false
                                vm.showError = !vm.errMsg.isEmpty
            }
        } label: {
            if isSending {
                            ProgressView()
                                .progressViewStyle(CircularProgressViewStyle(tint: .secondary))
                                .padding(10)
                        } else {
                            Image(systemName: "paperplane.fill")
                                .foregroundColor(vm.message.isEmpty ? .gray : .yellow)
                                .padding(10)
                        }
        }
        .disabled(isSending || vm.message.isEmpty)
                .background(Color(isSending || vm.message.isEmpty ? .secondarySystemBackground : .systemBlue))
                .clipShape(Circle())
                .padding(.trailing)
    }
}


struct ContentView: View {
    @FocusState private var messageInFocus: Bool // tap background to dismiss kbd
    @Environment(AppViewModel.self) private var vm

    var body: some View {
        VStack {
            ConversationView()
            
            HStack (alignment: .bottom) {
                            TextField(vm.instruction, text: Bindable(vm).message)
                                .focused($messageInFocus) // to dismiss keyboard
                                .textFieldStyle(.roundedBorder)
                                .cornerRadius(20)
                                .shadow(radius: 2)
                                .background(Color(.clear))
                                .border(Color(.clear))

                            SubmitButton()
                        }
                        .padding(EdgeInsets(top: 0, leading: 20, bottom: 8, trailing: 0))
                      
        }
        .contentShape(.rect)
                .onTapGesture {
                    messageInFocus.toggle()
                }
              
        .navigationTitle("llmPrompt")
        .navigationBarTitleDisplayMode(.inline)
        .alert("LLM Error", isPresented: Bindable(vm).showError) {
                        Button("OK") {
                            vm.errMsg = ""
                        }
                    } message: {
                        Text(vm.errMsg)
                    }

    }
}
