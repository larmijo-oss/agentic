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

                TextField(
                    vm.systemInstruction,
                    text: $vm.systemPrompt
                )
                .textFieldStyle(.roundedBorder)
                .disabled(vm.isStreaming)

                HStack(alignment: .bottom) {

                    TextField(
                        vm.userInstruction,
                        text: $vm.userPrompt
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
                                .progressViewStyle(
                                    CircularProgressViewStyle(
                                        tint: .secondary
                                    )
                                )
                                .padding(10)

                        } else {
                            Image(systemName: "paperplane.fill")
                                .foregroundColor(
                                    vm.sendDisabled
                                    ? .gray
                                    : .yellow
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

                Button("Clear") {
                    Task {
                        await vm.clear()
                    }
                }
                .disabled(vm.isStreaming)
            }
            .padding(.horizontal)
            .padding(.bottom, 8)
        }
        .contentShape(.rect)
        .onTapGesture {
            messageInFocus = false
        }
        .navigationTitle("Geography Games")
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
