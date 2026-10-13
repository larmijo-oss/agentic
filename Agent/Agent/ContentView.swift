//
//  ContentView.swift
//  Agent
//
//  Created by Lena Armijo on 9/4/26.
//


import SwiftUI

struct ContentView: View {
    @FocusState private var messageInFocus: Bool
    @Environment(AppViewModel.self) private var vm

    var body: some View {
        @Bindable var vm = vm

        VStack(spacing: 12) {
            
            
            Picker(
                "Game",
                selection: Binding(
                    get: {
                        vm.selectedGame
                    },
                    set: { newGame in
                        Task {
                            await vm.switchGame(to: newGame)
                        }
                    }
                )
            ) {
                ForEach(Game.allCases) { game in
                    Text(game.rawValue)
                        .tag(game)
                }
            }
            .pickerStyle(.segmented)
            .disabled(vm.isStreaming)
            .padding(.horizontal)
            
            
            ConversationView()
            
            
            
            VStack(spacing: 8) {

                Picker("Prompt Type", selection: $vm.useSystemPrompt) {
                    Text("User Prompt").tag(false)
                    Text("System Prompt").tag(true)
                }
                .pickerStyle(.segmented)
                .disabled(vm.isStreaming)

                HStack(alignment: .bottom) {

                    TextField(
                        vm.useSystemPrompt
                            ? vm.systemInstruction
                            : vm.userInstruction,
                        text: vm.useSystemPrompt
                            ? $vm.systemPrompt
                            : $vm.userPrompt
                    )
                    .focused($messageInFocus)
                    .textFieldStyle(.roundedBorder)
                    .disabled(vm.isStreaming)

                    Button {
                        Task {
                            await vm.send()
                        }
                    } label: {
                        if vm.isStreaming {
                            ProgressView()
                                .padding(10)
                        } else {
                            Image(systemName: "paperplane.fill")
                                .foregroundColor(
                                    vm.sendDisabled ? .gray : .yellow
                                )
                                .padding(10)
                        }
                    }
                    .disabled(vm.sendDisabled)
                    .background(
                        Color(
                            vm.sendDisabled
                            ? .secondarySystemBackground
                            : .systemBlue
                        )
                    )
                    .clipShape(Circle())
                }
            }
            .padding(.horizontal)

            
                
                Button("Clear") {
                    Task {
                        await vm.clear()
                    }
                }
                .disabled(vm.isStreaming)
                .padding(.bottom, 8)
            }
        
        .navigationTitle(vm.selectedGame.rawValue)
        .navigationBarTitleDisplayMode(.inline)
        .task {
            if !vm.hasStartedGame {
                await vm.startGame()
            }
        }
        .alert(
            "LLM Error",
            isPresented: $vm.showError
        ) {
            Button("OK") {
                vm.errMsg = ""
            }
        } message: {
            Text(vm.errMsg)
        }
    }
}
